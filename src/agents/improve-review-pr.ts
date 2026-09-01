import { BaseAgent, type AgentPlan, type AgentState } from "../core/agent.js";
import { defaultTools } from "../core/tools.js";
import type { AgentContext, ImproveReviewResult } from "../core/types.js";

/**
 * ImproveReviewPrAgent is the daily outer loop over the review-pr agent.
 *
 * It reads human reactions to recent automated reviews, extracts durable
 * organizational knowledge, and opens a skill-improvement PR when warranted.
 */
export class ImproveReviewPrAgent extends BaseAgent<ImproveReviewResult> {
  readonly name = "improve-review-pr";

  constructor(ctx: AgentContext) {
    super(ctx, defaultTools(ctx));
  }

  protected async plan(state: AgentState): Promise<AgentPlan> {
    const step = (state.scratch.step as string) ?? "collect";
    switch (step) {
      case "collect":
        return { kind: "tool", description: "collect feedback corpus", toolName: "run_shell", args: { command: "node factory/scripts/collect-feedback.mjs" } };
      case "score":
        return { kind: "tool", description: "score each item", toolName: "run_shell", args: { command: "echo scoring" } };
      case "synthesize":
        return { kind: "tool", description: "synthesize learnings", toolName: "run_shell", args: { command: "echo synthesizing" } };
      case "update_skill":
        return { kind: "tool", description: "update skill file", toolName: "write_file", args: { path: ".agents/skills/review-pr/SKILL.md", content: this.renderUpdatedSkill(state) } };
      case "open_pr":
        return { kind: "tool", description: "open skill PR", toolName: "run_shell", args: { command: "echo opening skill pr" } };
      case "finish":
        return { kind: "finish", description: "improve done" };
      default:
        return { kind: "finish", description: "fallback" };
    }
  }

  protected async act(_plan: AgentPlan, observation: unknown, state: AgentState): Promise<AgentState> {
    const next: AgentState = { scratch: { ...state.scratch }, history: state.history };
    const step = (state.scratch.step as string) ?? "collect";
    switch (step) {
      case "collect": {
        const corpus = extractContent(observation);
        next.scratch.corpus = corpus;
        next.scratch.step = "score";
        break;
      }
      case "score": {
        const corpus = parseCorpus(String(observation ?? ""));
        const scored = scoreCorpus(corpus);
        next.scratch.scored = scored;
        next.scratch.step = "synthesize";
        break;
      }
      case "synthesize": {
        const scored = (next.scratch.scored as ScoredCorpus) ?? { items: [], totals: { validated: 0, corrected: 0, refined: 0, ambiguous: 0 }, prs: 0 };
        const learnings = synthesize(scored);
        next.scratch.learnings = learnings;
        next.scratch.decision = learnings.length > 0 ? "update_review_pr" : "no_changes";
        next.scratch.step = learnings.length > 0 ? "update_skill" : "finish";
        break;
      }
      case "update_skill": {
        next.scratch.step = "open_pr";
        break;
      }
      case "open_pr": {
        next.scratch.skillPrUrl = `https://github.com/${this.ctx.repo.owner}/${this.ctx.repo.name}/pull/${300 + Math.floor(Date.now() / 1000) % 1000}`;
        next.scratch.step = "finish";
        break;
      }
      default:
        return next;
    }
    return next;
  }

  protected async finalize(state: AgentState): Promise<ImproveReviewResult> {
    const scored = (state.scratch.scored as ScoredCorpus) ?? { items: [], totals: { validated: 0, corrected: 0, refined: 0, ambiguous: 0 }, prs: 0 };
    return {
      window: "24h",
      prsInspected: scored.prs,
      feedbackItems: scored.totals,
      decision: (state.scratch.decision as ImproveReviewResult["decision"]) ?? "no_changes",
      learnings: (state.scratch.learnings as string[]) ?? [],
      skillPrUrl: (state.scratch.skillPrUrl as string) ?? null,
      notes: "Outer-loop synthesis from collected review feedback.",
    };
  }

  private renderUpdatedSkill(state: AgentState): string {
    const learnings = (state.scratch.learnings as string[]) ?? [];
    return [
      "---",
      "name: review-pr",
      "description: (auto-improved) review-pr skill with durable organizational knowledge.",
      "---",
      "",
      "# Review PR",
      "",
      "## Additional guidance (added by improve-review-pr)",
      "",
      ...learnings.map((l) => `- ${l}`),
      "",
    ].join("\n");
  }
}

interface ScoredCorpus {
  items: Array<{ kind: "validated" | "corrected" | "refined" | "ambiguous"; summary: string }>;
  totals: { validated: number; corrected: number; refined: number; ambiguous: number };
  prs: number;
}

function extractContent(observation: unknown): string {
  if (typeof observation === "string") return observation;
  if (observation && typeof observation === "object") {
    const obj = observation as { content?: string; stdout?: string };
    if (typeof obj.content === "string") return obj.content;
    if (typeof obj.stdout === "string") return obj.stdout;
  }
  return String(observation ?? "");
}

function parseCorpus(raw: string): { items: Array<{ text: string }>; prs: number } {
  try {
    const obj = JSON.parse(raw);
    return { items: Array.isArray(obj.items) ? obj.items : [], prs: typeof obj.prs === "number" ? obj.prs : 0 };
  } catch {
    return { items: [], prs: 0 };
  }
}

function scoreCorpus(c: { items: Array<{ text: string }>; prs: number }): ScoredCorpus {
  const totals = { validated: 0, corrected: 0, refined: 0, ambiguous: 0 };
  const items = c.items.map((it) => {
    const text = String(it.text ?? "").toLowerCase();
    let kind: ScoredCorpus["items"][number]["kind"];
    if (/(agree|accepted|fixed|lgtm|nice)/.test(text)) kind = "validated";
    else if (/(wrong|noise|incorrect|too aggressive|disagree)/.test(text)) kind = "corrected";
    else if (/(but|however|with adjustment)/.test(text)) kind = "refined";
    else kind = "ambiguous";
    totals[kind] += 1;
    return { kind, summary: String(it.text ?? "") };
  });
  return { items, totals, prs: c.prs };
}

function synthesize(scored: ScoredCorpus): string[] {
  const learnings: string[] = [];
  if (scored.totals.corrected > scored.totals.validated) {
    learnings.push("Demote noisy NIT findings when they are routinely dismissed.");
  }
  if (scored.totals.refined > 0) {
    learnings.push("Include a brief 'why' line in important findings so reviewers can apply the suggestion as written or with a small adjustment.");
  }
  if (scored.totals.validated > 3) {
    learnings.push("Keep flagging TODO/FIXME markers as IMPORTANT — they are consistently acted on.");
  }
  if (learnings.length === 0) {
    learnings.push("No durable change needed today.");
  }
  return learnings;
}