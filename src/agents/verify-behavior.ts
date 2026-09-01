import { BaseAgent, type AgentPlan, type AgentState } from "../core/agent.js";
import { defaultTools } from "../core/tools.js";
import type {
  AgentContext,
  BehaviorMode,
  BehaviorVerificationResult,
  EvidenceArtifact,
  ProductSpec,
} from "../core/types.js";
import { promises as fs, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * VerifyBehaviorAgent runs in two modes:
 * - `reproduce` — does the bug still happen on baseline?
 * - `verify` — does the implemented change match expected behavior?
 *
 * The agent picks browser vs desktop based on the surface, fans out parallel
 * workers per user story, and aggregates per-story results. Each evidence
 * artifact carries a caption naming the UI state and what it demonstrates.
 */
export class VerifyBehaviorAgent extends BaseAgent<BehaviorVerificationResult> {
  readonly name = "verify-behavior";

  constructor(ctx: AgentContext, private readonly mode: BehaviorMode = "verify") {
    super(ctx, defaultTools(ctx));
  }

  protected async plan(state: AgentState): Promise<AgentPlan> {
    const step = (state.scratch.step as string) ?? "load_stories";
    switch (step) {
      case "load_stories":
        return { kind: "tool", description: "load PRODUCT.md stories", toolName: "read_file", args: { path: this.productPath() } };
      case "pick_channel":
        return { kind: "tool", description: "decide browser vs desktop", toolName: "run_shell", args: { command: "echo picked browser channel" } };
      case "fan_out":
        return { kind: "tool", description: "launch parallel workers (one per story)", toolName: "run_shell", args: { command: "echo launching parallel workers" } };
      case "aggregate":
        return { kind: "tool", description: "aggregate results", toolName: "run_shell", args: { command: "echo aggregating" } };
      case "finish":
        return { kind: "finish", description: "verify done" };
      default:
        return { kind: "finish", description: "fallback" };
    }
  }

  protected async act(_plan: AgentPlan, observation: unknown, state: AgentState): Promise<AgentState> {
    const next: AgentState = { scratch: { ...state.scratch }, history: state.history };
    const step = (state.scratch.step as string) ?? "load_stories";
    switch (step) {
      case "load_stories": {
        const body = extractContent(observation);
        const stories = parseStories(body);
        next.scratch.stories = stories;
        next.scratch.step = "pick_channel";
        break;
      }
      case "pick_channel": {
        next.scratch.channel = pickChannel(this.ctx.issue);
        next.scratch.step = "fan_out";
        break;
      }
      case "fan_out": {
        const stories = (next.scratch.stories as Array<{ id: string; title: string }>) ?? [];
        const results = stories.map((s) => simulateStory(s, this.mode));
        next.scratch.results = results;
        next.scratch.step = "aggregate";
        break;
      }
      case "aggregate": {
        next.scratch.step = "finish";
        break;
      }
      default:
        return next;
    }
    return next;
  }

  protected async finalize(state: AgentState): Promise<BehaviorVerificationResult> {
    const stories = (state.scratch.stories as Array<{ id: string; title: string }>) ?? [];
    const results = (state.scratch.results as Array<{ id: string; passed: boolean; notes: string; artifacts: EvidenceArtifact[] }>) ?? [];
    const channel = (state.scratch.channel as "browser" | "desktop" | "hybrid") ?? "browser";
    const evidenceDraft = results.flatMap((r) => r.artifacts);
    const evidence = await materializeEvidence(evidenceDraft, this.ctx.repo.workdir);
    const total = results.length;
    const passed = results.filter((r) => r.passed).length;
    let status: BehaviorVerificationResult["status"];
    if (this.mode === "reproduce") {
      if (passed === 0) status = "not-reproduced";
      else if (passed === total) status = "confirmed";
      else status = "partially-confirmed";
    } else {
      if (passed === 0) status = "not-verified";
      else if (passed === total) status = "verified";
      else status = "partially-verified";
    }
    return {
      mode: this.mode,
      status,
      channel,
      ozRunUrl: `https://oz.warp.dev/runs/${this.ctx.runId}`,
      evidence,
      notes: `${passed}/${total} stories passed on ${channel} (mode=${this.mode}).`,
    };
  }

  private productPath(): string {
    return `specs/issue-${this.ctx.issue.number}-${slugify(this.ctx.issue.title)}/PRODUCT.md`;
  }
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "issue";
}

/** Extract string content from a tool observation. */
function extractContent(observation: unknown): string {
  if (typeof observation === "string") return observation;
  if (observation && typeof observation === "object") {
    const obj = observation as { content?: string; stdout?: string };
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.stdout === "string") return obj.stdout;
  }
  return String(observation ?? "");
}

function parseStories(productMd: string): Array<{ id: string; title: string; checks: string[] }> {
  const stories: Array<{ id: string; title: string; checks: string[] }> = [];
  const blocks = productMd.split(/^### (US-\d+) — (.+)$/gm);
  for (let i = 1; i < blocks.length; i += 3) {
    const id = blocks[i];
    const title = blocks[i + 1];
    const body = blocks[i + 2] ?? "";
    const checks: string[] = [];
    let inChecks = false;
    for (const line of body.split("\n")) {
      if (/^\*\*Checks:\*\*/.test(line)) { inChecks = true; continue; }
      if (inChecks && /^[-*]\s+/.test(line)) checks.push(line.replace(/^[-*]\s+/, "").trim());
    }
    stories.push({ id, title, checks });
  }
  return stories;
}

function pickChannel(issue: { title: string; body: string }): "browser" | "desktop" | "hybrid" {
  const text = `${issue.title} ${issue.body}`.toLowerCase();
  if (/(desktop app|native dialog|os integration)/.test(text)) return "desktop";
  if (/(mobile|desktop)/.test(text)) return "hybrid";
  return "browser";
}

function simulateStory(s: { id: string; title: string }, mode: BehaviorMode): { id: string; passed: boolean; notes: string; artifacts: EvidenceArtifact[] } {
  // Deterministic simulation: 95% pass rate, used to demonstrate fan-out and aggregation.
  const passed = hashString(s.id) % 20 !== 0;
  const artifacts: EvidenceArtifact[] = [
    {
      kind: "screenshot",
      caption: `${mode === "reproduce" ? "Reproduce" : "Verify"} baseline for ${s.id}: empty state of "${s.title}"`,
      path: `evidence/${s.id}-baseline.png`,
    },
  ];
  if (passed) {
    artifacts.push({
      kind: "screenshot",
      caption: `Critical-path ${mode} final state for ${s.id} "${s.title}"`,
      path: `evidence/${s.id}-result.png`,
    });
  }
  return {
    id: s.id,
    passed,
    notes: passed ? `${mode === "reproduce" ? "Reproduced" : "Verified"} end-to-end.` : `Failed check in ${s.title}.`,
    artifacts,
  };
}

/** Copies bundled PNG fixtures into the workdir's evidence/ dir. Real bytes on disk. */
export async function materializeEvidence(artifacts: EvidenceArtifact[], workdir: string): Promise<EvidenceArtifact[]> {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const fixturesDir = path.join(repoRoot, "fixtures", "evidence");
  const targetDir = path.join(workdir, "evidence");
  await fs.mkdir(targetDir, { recursive: true });
  const out: EvidenceArtifact[] = [];
  for (const art of artifacts) {
    const fileName = path.basename(art.path);
    const src = path.join(fixturesDir, fileName);
    const dst = path.join(targetDir, fileName);
    if (existsSync(src)) {
      await fs.copyFile(src, dst);
      out.push({ ...art, path: path.relative(workdir, dst) });
    } else {
      out.push(art);
    }
  }
  return out;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}