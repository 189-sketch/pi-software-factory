/**
 * Smoke test for the LLM-mode triage agent against the real MiniMax-M3 endpoint.
 *
 * Run with:
 *   npx tsx scripts/llm-smoke.ts
 */
import { runLlmAgent } from "../src/core/llm-agent.js";
import { isLlmConfigured } from "../src/core/llm.js";
import { defaultTools } from "../src/core/tools.js";
import { ConsoleLogger } from "../src/core/log.js";
import { promises as fs } from "node:fs";
import path from "node:path";

async function main() {
  if (!isLlmConfigured()) {
    console.error("LLM not configured; set ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) and ANTHROPIC_BASE_URL");
    process.exit(1);
  }

  const fixturePath = "/Users/mustang/Projects/cloud-factory-demo/factory/fixtures/issues/001-add-download-button.json";
  const issue = JSON.parse(await fs.readFile(fixturePath, "utf-8"));

  const ctx = {
    repo: { owner: "demo", name: "factory-target", defaultBranch: "main", workdir: process.cwd() },
    issue: { ...issue, labels: [], author: issue.author ?? "alice", url: issue.url ?? "", createdAt: issue.createdAt ?? "", comments: [] },
    logger: new ConsoleLogger(),
    skillBody: await fs.readFile(path.join(process.cwd(), "skills", "triage", "SKILL.md"), "utf-8"),
    runId: "smoke",
  };

  const result = await runLlmAgent({
    name: "triage",
    ctx,
    systemPrompt: `You are the triage agent for the multi-agent software factory.\n\n${ctx.skillBody}\n\nYou have file system and shell tools. Use them to inspect the repo before deciding.`,
    userPrompt: `Triage issue #${issue.number}: ${issue.title}\n\nBody:\n${issue.body}\n\nReturn your final answer as a JSON object with the keys: state, label, remove_labels, comment. State must be one of: "Ready to implement", "Ready to spec", "Needs info", "Wait to implement".`,
    extraTools: defaultTools(ctx),
    parse: (text) => {
      // Find the last balanced JSON object in the text.
      let last: any = null;
      const decoder = new TextDecoder();
      let depth = 0;
      let start = -1;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "{") {
          if (depth === 0) start = i;
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0 && start >= 0) {
            try {
              const obj = JSON.parse(text.slice(start, i + 1));
              if (obj && typeof obj.state === "string" && typeof obj.label === "string") {
                last = obj;
              }
            } catch {}
            start = -1;
          }
        }
      }
      if (!last) throw new Error("LLM did not return a valid triage JSON:\n" + text);
      return last;
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});