import { BaseAgent, type AgentPlan, type AgentState, stdoutOf, agentLogger } from "../core/agent.js";
import { defaultTools } from "../core/tools.js";
import type { AgentContext, TriageLabel, TriageResult, TriageState } from "../core/types.js";

/**
 * TriageAgent decides the readiness state for an issue.
 *
 * Follows the canonical SKILL.md rubric:
 * - inspect issue + codebase + roadmap/vision
 * - classify into exactly one of four states
 * - return JSON: { state, label, remove_labels, comment }
 */
export class TriageAgent extends BaseAgent<TriageResult> {
  readonly name = "triage";

  constructor(ctx: AgentContext) {
    super(ctx, defaultTools(ctx));
  }

  protected async plan(state: AgentState): Promise<AgentPlan> {
    const step = (state.scratch.step as string) ?? "fetch_issue";
    switch (step) {
      case "fetch_issue":
        return { kind: "tool", description: "fetch full issue context", toolName: "fetch_issue", args: { issueNumber: this.ctx.issue.number } };
      case "inspect_code":
        return { kind: "tool", description: "inspect roadmap", toolName: "read_file", args: { path: "roadmap.md" } };
      case "inspect_code_vision":
        return { kind: "tool", description: "inspect vision", toolName: "read_file", args: { path: "vision.md" } };
      case "list_root":
        return { kind: "tool", description: "list repo root", toolName: "list_dir", args: { path: "." } };
      case "update_labels":
        return { kind: "tool", description: "apply triage label", toolName: "update_issue_labels", args: { add: [state.scratch.label as string], remove: state.scratch.remove_labels as string[] } };
      case "draft_comment":
        return { kind: "tool", description: "synthesize comment", toolName: "post_issue_comment", args: { body: (state.scratch.comment as string) ?? "" } };
      case "finish":
        return { kind: "finish", description: "triage done" };
      default:
        return { kind: "finish", description: "unknown step fallback" };
    }
  }

  protected async act(plan: AgentPlan, observation: unknown, state: AgentState): Promise<AgentState> {
    const next: AgentState = { scratch: { ...state.scratch }, history: state.history };
    const step = (state.scratch.step as string) ?? "fetch_issue";
    switch (step) {
      case "fetch_issue": {
        const issue = this.ctx.issue;
        next.scratch.title = issue.title;
        next.scratch.body = issue.body;
        next.scratch.labels = issue.labels;
        // Heuristic rubric for demo: use title/body keywords to choose state.
        const text = `${issue.title} ${issue.body}`.toLowerCase();
        if (/(needs more info|unclear|ambiguous|what do you mean|could you clarify|not sure|kind of|or something\?|maybe)/.test(text)) {
          next.scratch.state = "Needs info";
          next.scratch.label = "needs-info";
          next.scratch.remove_labels = ["ready-to-implement", "ready-to-spec", "wait-to-implement", "spec-ready-for-review"];
        } else if (/(doesn't fit|out of scope|premature|hold off|off topic|nft|blockchain|let's wait)/.test(text)) {
          next.scratch.state = "Wait to implement";
          next.scratch.label = "wait-to-implement";
          next.scratch.remove_labels = ["ready-to-implement", "ready-to-spec", "needs-info", "spec-ready-for-review"];
        } else if (/(spec|architecture|redesign|migration|major|breaking|provider|state management)/.test(text)) {
          next.scratch.state = "Ready to spec";
          next.scratch.label = "ready-to-spec";
          next.scratch.remove_labels = ["ready-to-implement", "needs-info", "wait-to-implement", "spec-ready-for-review"];
        } else {
          next.scratch.state = "Ready to implement";
          next.scratch.label = "ready-to-implement";
          next.scratch.remove_labels = ["ready-to-spec", "needs-info", "wait-to-implement", "spec-ready-for-review"];
        }
        const stateName = next.scratch.state as TriageState;
        const rationale = buildRationale(stateName, this.ctx.issue);
        next.scratch.comment = [
          `**Triage decision:** ${stateName}`,
          "",
          rationale,
          "",
          "**Next step:** " + nextStep(stateName),
        ].join("\n");
        next.scratch.step = "inspect_code";
        return next;
      }
      case "inspect_code":
      case "inspect_code_vision":
      case "list_root": {
        // Roadmap / vision / repo root are informational; advance through them.
        const advance: Record<string, string> = {
          inspect_code: "inspect_code_vision",
          inspect_code_vision: "list_root",
          list_root: "update_labels",
        };
        next.scratch.step = advance[step] ?? "update_labels";
        return next;
      }
      case "update_labels":
        next.scratch.step = "draft_comment";
        return next;
      case "draft_comment": {
        next.scratch.step = "finish";
        return next;
      }
      default:
        return next;
    }
  }

  protected async finalize(state: AgentState): Promise<TriageResult> {
    return {
      state: state.scratch.state as TriageState,
      label: state.scratch.label as TriageLabel,
      remove_labels: (state.scratch.remove_labels as TriageLabel[]) ?? [],
      comment: (state.scratch.comment as string) ?? "",
    };
  }
}

function nextStep(state: TriageState): string {
  switch (state) {
    case "Ready to implement":
      return "Apply `Ready to implement` so the implementation agent can pick this up.";
    case "Ready to spec":
      return "Apply `Ready to spec` so the spec agent drafts `PRODUCT.md` + `TECH.md`.";
    case "Needs info":
      return "Reply with the missing details so we can re-triage.";
    case "Wait to implement":
      return "Hold off on implementation; revisit if scope or product direction changes.";
  }
}

function buildRationale(state: TriageState, issue: { title: string; body: string }): string {
  const evidence = issue.body.split("\n").filter(Boolean).slice(0, 3).map((l) => `- ${l}`).join("\n");
  switch (state) {
    case "Ready to implement":
      return "Scope looks bounded and aligned with the current product direction.\n\n**Evidence:**\n" + (evidence || "- (no body)");
    case "Ready to spec":
      return "Product goal is clear, but the work touches multiple areas or has meaningful product/technical ambiguity, so a spec is warranted.\n\n**Evidence:**\n" + (evidence || "- (no body)");
    case "Needs info":
      return "Cannot responsibly route this without more detail.\n\n**Evidence:**\n" + (evidence || "- (no body)");
    case "Wait to implement":
      return "Does not fit the current product direction or duplicates planned work.\n\n**Evidence:**\n" + (evidence || "- (no body)");
  }
}
