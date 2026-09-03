#!/usr/bin/env node
/**
 * CLI entry point for the multi-agent software factory.
 *
 * Usage:
 *   tsx src/cli/run-issue.ts --issue fixtures/issues/1.json
 *   tsx src/cli/run-issue.ts --all            (runs every fixture issue)
 *   tsx src/cli/run-issue.ts --webhook 8080   (starts the webhook server)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FactoryOrchestrator } from "../orchestrator/index.js";
import { loadIssues } from "../github/local.js";
import { startWebhookServer } from "../github/webhook.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillsRoot = path.join(__dirname, "..", "..", "skills");
const fixturesDir = path.join(__dirname, "..", "..", "fixtures", "issues");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // Use process.cwd() so tests can point the CLI at a temp directory.
  const repoRoot = process.cwd();
  const remotePath = process.env.FACTORY_REMOTE_PATH || args.remote || "";
  const orchestrator = new FactoryOrchestrator({
    skillsRoot,
    repo: { owner: "demo", name: "factory-target", defaultBranch: "main", workdir: repoRoot },
    remotePath,
  });

  if (args.webhook) {
    startWebhookServer({ port: args.webhook, orchestrator });
    return;
  }

  const issues = args.all
    ? await loadIssues(fixturesDir)
    : args.issue
      ? [await loadOne(args.issue)]
      : [];
  if (issues.length === 0) {
    console.error("no issues to process; pass --issue <file> or --all or --webhook <port>");
    process.exit(1);
  }

  for (const issue of issues) {
    let result;
    if (args.stage === "triage") {
      result = await orchestrator.runTriage(issue);
    } else if (args.stage === "improve-review-pr") {
      result = await orchestrator.runImproveReviewPr(issue);
    } else if (args.stage === "verify-behavior") {
      result = await orchestrator.runVerifyBehavior(issue);
    } else {
      result = await orchestrator.runForIssue(issue);
    }
    console.log(JSON.stringify(summarize(result, args.stage), null, 2));
  }

  await orchestrator.persist();
}

function summarize(state: any, stage?: string) {
  if (stage === "improve-review-pr") {
    return {
      issue: state.issue?.number,
      decision: state.decision,
      prsInspected: state.prsInspected,
      feedbackItems: state.feedbackItems,
      learnings: state.learnings,
      skillPrUrl: state.skillPrUrl,
    };
  }
  if (stage === "verify-behavior") {
    return {
      issue: state.issue?.number,
      mode: state.mode,
      status: state.status,
      channel: state.channel,
      ozRunUrl: state.ozRunUrl,
      evidenceCount: state.evidence?.length ?? 0,
    };
  }
  return {
    issue: state.issue.number,
    title: state.issue.title,
    triage: state.triage?.state,
    specs: state.specs ? { branch: state.specs.specBranch, prUrl: state.specs.specPrUrl } : null,
    implementation: state.implementation ? { branch: state.implementation.branch, prUrl: state.implementation.prUrl, filesChanged: state.implementation.filesChanged } : null,
    review: state.review ? { verdict: state.review.verdict, comments: state.review.comments.length, body: state.review.body } : null,
    verify: state.implementation?.behaviorVerification?.status,
    merged: state.merged,
  };
}

async function loadOne(p: string) {
  const fs = await import("node:fs/promises");
  const raw = await fs.readFile(p, "utf-8");
  const obj = JSON.parse(raw);
  return {
    number: obj.number,
    title: obj.title,
    body: obj.body ?? "",
    labels: obj.labels ?? [],
    author: obj.author ?? "demo-user",
    url: obj.url ?? "",
    createdAt: obj.createdAt ?? new Date().toISOString(),
    comments: obj.comments ?? [],
  };
}

function parseArgs(argv: string[]): { issue?: string; all?: boolean; webhook?: number; stage?: string; remote?: string } {
  const out: { issue?: string; all?: boolean; webhook?: number; stage?: string; remote?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--issue") out.issue = argv[++i];
    else if (a === "--all") out.all = true;
    else if (a === "--webhook") out.webhook = Number(argv[++i]);
    else if (a === "--stage") out.stage = argv[++i];
    else if (a === "--remote") out.remote = argv[++i];
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
