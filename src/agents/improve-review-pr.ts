import path from "node:path";
import { fileURLToPath } from "node:url";
import { BaseAgent, type AgentPlan, type AgentState } from "../core/agent.js";
import { commitAndPushTool, defaultTools, openPullRequestTool } from "../core/tools.js";
import type { AgentContext, ImproveReviewResult } from "../core/types.js";

/**
 * Daily outer loop over review-pr.
 *
 * Only real GitHub feedback from the last 24 hours may change the skill. A
 * durable learning is committed and proposed through the same git/PR tools as
 * implementation work; an empty corpus is an explicit no-op.
 */
export class ImproveReviewPrAgent extends BaseAgent<ImproveReviewResult> {
  readonly name = "improve-review-pr";
  private readonly reviewSkillBody: string;

  constructor(ctx: AgentContext, remotePath = "", reviewSkillBody = "") {
    super(ctx, [
      ...defaultTools(ctx),
      commitAndPushTool(ctx),
      openPullRequestTool(ctx, remotePath),
    ]);
    this.reviewSkillBody = reviewSkillBody;
  }

  protected async plan(state: AgentState): Promise<AgentPlan> {
    const step = (state.scratch.step as string) ?? "collect";
    switch (step) {
      case "collect":
        return {
          kind: "tool",
          description: "collect real GitHub review feedback from the last 24 hours",
          toolName: "run_shell",
          args: { command: `node ${JSON.stringify(collectFeedbackPath())}` },
        };
      case "update_skill":
        return {
          kind: "tool",
          description: "append durable guidance to the review skill",
          toolName: "write_file",
          args: { path: ".agents/skills/review-pr/SKILL.md", content: this.renderUpdatedSkill(state) },
        };
      case "commit":
        return {
          kind: "tool",
          description: "commit and push review skill learning",
          toolName: "commit_and_push",
          args: {
            branch: this.branchName(),
            message: "Improve review-pr from validated feedback",
            files: [".agents/skills/review-pr/SKILL.md"],
          },
        };
      case "open_pr":
        return {
          kind: "tool",
          description: "open review skill improvement PR",
          toolName: "open_pull_request",
          args: {
            branch: this.branchName(),
            baseBranch: this.ctx.repo.defaultBranch,
            title: "Improve review-pr from daily feedback",
            body: this.pullRequestBody(state),
          },
        };
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
        const shell = observation as { exitCode?: number; stderr?: string } | null;
        if (shell && typeof shell.exitCode === "number" && shell.exitCode !== 0) {
          throw new Error(`feedback collection failed: ${String(shell.stderr ?? "unknown error").trim()}`);
        }
        const scored = scoreCorpus(parseCorpus(extractContent(observation)));
        const learnings = synthesize(scored);
        next.scratch.scored = scored;
        next.scratch.learnings = learnings;
        next.scratch.decision = learnings.length > 0 ? "update_review_pr" : "no_changes";
        next.scratch.step = learnings.length > 0 ? "update_skill" : "finish";
        break;
      }
      case "update_skill":
        next.scratch.step = "commit";
        break;
      case "commit":
        next.scratch.commit = observation;
        next.scratch.step = "open_pr";
        break;
      case "open_pr": {
        const result = observation as { prUrl?: string; url?: string } | null;
        next.scratch.skillPrUrl = result?.prUrl ?? result?.url ?? null;
        if (!next.scratch.skillPrUrl) {
          throw new Error("review skill PR creation returned no URL");
        }
        next.scratch.step = "finish";
        break;
      }
      default:
        return next;
    }
    return next;
  }

  protected async finalize(state: AgentState): Promise<ImproveReviewResult> {
    const scored = (state.scratch.scored as ScoredCorpus) ?? emptyScore();
    return {
      window: "24h",
      prsInspected: scored.prs,
      feedbackItems: scored.totals,
      decision: (state.scratch.decision as ImproveReviewResult["decision"]) ?? "no_changes",
      learnings: (state.scratch.learnings as string[]) ?? [],
      skillPrUrl: (state.scratch.skillPrUrl as string) ?? null,
      notes: "Outer-loop synthesis from real GitHub review feedback.",
    };
  }

  private branchName(): string {
    return `factory/improve-review-pr-${new Date().toISOString().slice(0, 10)}`;
  }

  private renderUpdatedSkill(state: AgentState): string {
    const learnings = (state.scratch.learnings as string[]) ?? [];
    const base = this.reviewSkillBody.trimEnd() || [
      "---",
      "name: review-pr",
      "description: Review pull requests and report actionable findings.",
      "---",
      "",
      "# Review PR",
    ].join("\n");
    return [
      base,
      "",
      `## Validated guidance (${new Date().toISOString().slice(0, 10)})`,
      "",
      ...learnings.map((learning) => `- ${learning}`),
      "",
    ].join("\n");
  }

  private pullRequestBody(state: AgentState): string {
    const learnings = (state.scratch.learnings as string[]) ?? [];
    return [
      "Updates review-pr using durable patterns found in human feedback from the last 24 hours.",
      "",
      ...learnings.map((learning) => `- ${learning}`),
    ].join("\n");
  }
}

interface ScoredCorpus {
  items: Array<{ kind: "validated" | "corrected" | "refined" | "ambiguous"; summary: string }>;
  totals: { validated: number; corrected: number; refined: number; ambiguous: number };
  prs: number;
}

function collectFeedbackPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "scripts", "collect-feedback.mjs");
}

function emptyScore(): ScoredCorpus {
  return { items: [], totals: { validated: 0, corrected: 0, refined: 0, ambiguous: 0 }, prs: 0 };
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
    throw new Error("feedback collector returned invalid JSON");
  }
}

function scoreCorpus(corpus: { items: Array<{ text: string }>; prs: number }): ScoredCorpus {
  const scored = emptyScore();
  scored.prs = corpus.prs;
  scored.items = corpus.items.map((item) => {
    const summary = String(item.text ?? "");
    const text = summary.toLowerCase();
    let kind: ScoredCorpus["items"][number]["kind"];
    if (/(agree|accepted|fixed|lgtm|nice|good catch)/.test(text)) kind = "validated";
    else if (/(wrong|noise|incorrect|too aggressive|disagree)/.test(text)) kind = "corrected";
    else if (/(but|however|with adjustment)/.test(text)) kind = "refined";
    else kind = "ambiguous";
    scored.totals[kind] += 1;
    return { kind, summary };
  });
  return scored;
}

function synthesize(scored: ScoredCorpus): string[] {
  const learnings: string[] = [];
  if (scored.totals.corrected > scored.totals.validated) {
    learnings.push("Demote noisy NIT findings when reviewers routinely dismiss them.");
  }
  if (scored.totals.refined > 0) {
    learnings.push("Explain why important findings matter so reviewers can safely refine the suggested fix.");
  }
  if (scored.totals.validated > 3) {
    learnings.push("Keep reporting TODO and FIXME markers as IMPORTANT when reviewers consistently act on them.");
  }
  return learnings;
}
