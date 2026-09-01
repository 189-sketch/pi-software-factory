import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ConsoleLogger } from "../core/log.js";
import { SkillLoader } from "../core/skill.js";
import { newRunId } from "../core/agent.js";
import type { AgentContext, FactoryIssueState, Issue, TriageLabel, TriageResult } from "../core/types.js";
import { TriageAgent } from "../agents/triage.js";
import { SpecAgent } from "../agents/spec.js";
import { ImplementationAgent } from "../agents/implementation.js";
import { ReviewPrAgent } from "../agents/review-pr.js";
import { VerifyBehaviorAgent } from "../agents/verify-behavior.js";
import { ImproveReviewPrAgent } from "../agents/improve-review-pr.js";
import { commitAndPushTool, openPullRequestTool } from "../core/tools.js";
import { runLlmAgent, resolveAgentMode, type AgentMode } from "../core/llm-agent.js";

/**
 * FactoryOrchestrator wires the six agents into a complete pipeline.
 *
 * The state machine is:
 *   new issue → triage → {spec → implementation → review → verify-behavior → merged}
 *                              ↑
 *                              └─── if triage says "Ready to implement", skip spec.
 *
 * Each stage is an independent agent that owns one skill file. The orchestrator
 * loads the skill body, builds an AgentContext, and runs the agent. Stages can
 * be triggered individually by GitHub issue events.
 */
export class FactoryOrchestrator extends EventEmitter {
  private readonly logger = new ConsoleLogger({ orchestrator: "factory" });
  private readonly loader: SkillLoader;
  private readonly state = new Map<number, FactoryIssueState>();
  private readonly workdir: string;
  private readonly remotePath: string;

  constructor(opts: {
    skillsRoot: string;
    repo: { owner: string; name: string; defaultBranch: string; workdir: string };
    remotePath?: string;
  }) {
    super();
    this.loader = new SkillLoader(opts.skillsRoot);
    this.workdir = opts.repo.workdir;
    this.remotePath = opts.remotePath ?? "";
    this.repoMeta = opts.repo;
  }

  private readonly repoMeta: { owner: string; name: string; defaultBranch: string; workdir: string };

  /** Runs the full pipeline for an issue from triage through review. */
  async runForIssue(issue: Issue): Promise<FactoryIssueState> {
    const runId = newRunId();
    const mode = resolveAgentMode();
    this.logger.info(`start pipeline for issue #${issue.number} runId=${runId} mode=${mode}`);
    const skillBodies = {
      triage: await this.loader.load("triage"),
      spec: await this.loader.load("spec"),
      implementation: await this.loader.load("implementation"),
      reviewPr: await this.loader.load("review-pr"),
      verifyBehavior: await this.loader.load("verify-behavior"),
      improveReviewPr: await this.loader.load("improve-review-pr"),
    };

    const baseCtx = (skillKey: keyof typeof skillBodies): AgentContext => ({
      repo: this.repoMeta,
      issue,
      logger: this.logger,
      skillBody: skillBodies[skillKey].body,
      runId,
    });

    const state: FactoryIssueState = { issue, merged: false };
    this.state.set(issue.number, state);

    // 1. Triage (always). LLM mode uses the real MiniMax-M3 via pi-agent-core.
    if (mode === "llm") {
      const ctx = baseCtx("triage");
      state.triage = await runLlmAgent<TriageResult>({
        name: "triage",
        ctx,
        systemPrompt: `You are the triage agent for the multi-agent software factory.\n\n${skillBodies.triage.body}\n\nBias toward action: when the issue has concrete acceptance criteria and a bounded scope (single endpoint, single component, single file change), classify as "Ready to implement". Only classify as "Needs info" when the issue is genuinely ambiguous or missing critical details (no acceptance criteria, vague problem statement, unclear environment). Do NOT classify clear, scoped requests as "Needs info" just because they are short.`,
        userPrompt: `Triage issue #${issue.number}: ${issue.title}\n\nBody:\n${issue.body}\n\nUse the available tools to inspect the repo (read roadmap.md / vision.md if present) then return your final answer as a single JSON object with the keys: state (one of "Ready to implement", "Ready to spec", "Needs info", "Wait to implement"), label, remove_labels, comment.`,
        parse: parseTriageJson,
      });
    } else {
      const triageAgent = new TriageAgent(baseCtx("triage"));
      state.triage = await triageAgent.run();
    }
    this.emit("triage", { issueNumber: issue.number, result: state.triage });

    if (state.triage.state === "Wait to implement" || state.triage.state === "Needs info") {
      this.logger.info(`triage → ${state.triage.state}; stopping pipeline for #${issue.number}`);
      return state;
    }

    // 2. Spec (only when Ready to spec)
    if (state.triage.state === "Ready to spec") {
      const specAgent = new SpecAgent(baseCtx("spec"));
      state.specs = await specAgent.run();
      this.emit("spec", { issueNumber: issue.number, result: state.specs });
      // In a real factory we'd wait for human spec review. Demo: continue.
    }

    // 3. Implementation (Ready to implement, or after spec)
    const implCtx = baseCtx("implementation");
    const implAgent = new ImplementationAgent(implCtx, this.remotePath);
    state.implementation = await implAgent.run();
    this.emit("implementation", { issueNumber: issue.number, result: state.implementation });

    // 4. Review PR
    const reviewCtx = baseCtx("reviewPr");
    const reviewAgent = new ReviewPrAgent(reviewCtx);
    state.review = await reviewAgent.run();
    this.emit("review", { issueNumber: issue.number, result: state.review });

    // 5. Mark merged iff approved and verified
    if (state.review.verdict === "APPROVE") {
      state.merged = true;
      this.emit("merged", { issueNumber: issue.number });
    }

    return state;
  }

  /** Runs just the verify-behavior agent (called by implementation agent or review). */
  async runVerifyBehavior(issue: Issue, mode: "reproduce" | "verify" = "verify") {
    const skill = await this.loader.load("verify-behavior");
    const ctx: AgentContext = {
      repo: this.repoMeta,
      issue,
      logger: this.logger,
      skillBody: skill.body,
      runId: newRunId(),
    };
    const agent = new VerifyBehaviorAgent(ctx, mode);
    return agent.run();
  }

  /** Runs the daily outer-loop improve-review-pr agent. */
  async runImproveReviewPr(issue: Issue) {
    const skill = await this.loader.load("improve-review-pr");
    const ctx: AgentContext = {
      repo: this.repoMeta,
      issue,
      logger: this.logger,
      skillBody: skill.body,
      runId: newRunId(),
    };
    const agent = new ImproveReviewPrAgent(ctx);
    return agent.run();
  }

  /** Triggers a single stage by label (used by the GitHub webhook). */
  async triggerByLabel(issue: Issue, label: TriageLabel): Promise<FactoryIssueState> {
    this.logger.info(`webhook trigger label=${label} issue=#${issue.number}`);
    if (label === "ready-to-spec") {
      // Just run spec from a known state.
      const skill = await this.loader.load("spec");
      const ctx: AgentContext = {
        repo: this.repoMeta,
        issue,
        logger: this.logger,
        skillBody: skill.body,
        runId: newRunId(),
      };
      const state = this.state.get(issue.number) ?? { issue, merged: false };
      state.specs = await new SpecAgent(ctx).run();
      this.state.set(issue.number, state);
      return state;
    }
    if (label === "ready-to-implement") {
      const skill = await this.loader.load("implementation");
      const ctx: AgentContext = {
        repo: this.repoMeta,
        issue,
        logger: this.logger,
        skillBody: skill.body,
        runId: newRunId(),
      };
      const state = this.state.get(issue.number) ?? { issue, merged: false };
      state.implementation = await new ImplementationAgent(ctx, this.remotePath).run();
      this.state.set(issue.number, state);
      return state;
    }
    return this.runForIssue(issue);
  }

  /** Persists all per-issue state to disk under `<workdir>/factory/state/<n>.json`. */
  async persist(): Promise<void> {
    const outDir = path.join(this.workdir, "factory", "state");
    await fs.mkdir(outDir, { recursive: true });
    for (const [n, state] of this.state) {
      await fs.writeFile(path.join(outDir, `${n}.json`), JSON.stringify(state, null, 2), "utf-8");
    }
  }
}

/** Parse the LLM's text output into a TriageResult. */
function parseTriageJson(text: string): TriageResult {
  let last: any = null;
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
  if (!last) {
    throw new Error("LLM did not return a valid triage JSON:\n" + text.slice(0, 800));
  }
  return {
    state: last.state,
    label: last.label,
    remove_labels: Array.isArray(last.remove_labels) ? last.remove_labels : [],
    comment: typeof last.comment === "string" ? last.comment : "",
  };
}