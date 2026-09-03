import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ConsoleLogger } from "../core/log.js";
import { SkillLoader } from "../core/skill.js";
import { newRunId } from "../core/agent.js";
import type { AgentContext, FactoryIssueState, Issue, TriageLabel, TriageResult } from "../core/types.js";
import { TriageAgent } from "../agents/triage.js";
import { SpecAgent } from "../agents/spec.js";
import { ImplementationAgent } from "../agents/implementation.js";
import { slugify } from "../agents/spec.js";
import { ReviewPrAgent } from "../agents/review-pr.js";
import { VerifyBehaviorAgent } from "../agents/verify-behavior.js";
import { ImproveReviewPrAgent } from "../agents/improve-review-pr.js";
import { mergePullRequest } from "../github/git.js";
import { runLlmAgent, resolveAgentMode, type AgentMode } from "../core/llm-agent.js";
import { commitAndPushTool, defaultTools, openPullRequestTool } from "../core/tools.js";
import type { ImplementationResult } from "../core/types.js";

const exec = promisify(execFile);

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

  /** Runs only triage and records the resulting issue state. */
  async runTriage(issue: Issue): Promise<FactoryIssueState> {
    const runId = newRunId();
    const mode = resolveAgentMode();
    this.logger.info(`start triage for issue #${issue.number} runId=${runId} mode=${mode}`);
    const skill = await this.loader.load("triage");
    const state: FactoryIssueState = { issue, merged: false };
    this.state.set(issue.number, state);
    state.triage = await this.executeTriage(issue, skill.body, runId, mode);
    this.emit("triage", { issueNumber: issue.number, result: state.triage });
    return state;
  }

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

    // 1. Triage (always). LLM mode uses the configured Anthropic-compatible model.
    state.triage = await this.executeTriage(issue, skillBodies.triage.body, runId, mode);
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
    if (mode === "llm") {
      const skillBody = skillBodies.implementation.body;
      const userPrompt = [
        `Implement issue #${issue.number}: ${issue.title}`,
        ``,
        `Body / acceptance criteria:`,
        issue.body,
        ``,
        `Repo workdir: ${this.workdir}`,
        `Use the available tools (read_file, write_file, run_shell, commit_and_push, open_pull_request) to:`,
        `  1. Inspect the existing repo structure (run_shell: ls).`,
        `  2. Choose descriptive kebab-case file paths derived from the issue title`,
        `     (e.g. src/cosmic-core.js, tests/cosmic-core.test.js, or whatever convention the repo already uses).`,
        `     NEVER use the legacy 'feature-<number>.*' pattern — that hardcodes the issue id into the file name and gets REJECTed by review-pr.`,
        `  3. Implement the smallest cohesive change that satisfies every acceptance criterion in the issue body.`,
        `  4. Write a real Node.js test file using node:test + node:assert that exercises the happy path AND every error path. Run it with node --test until it passes.`,
        `  5. Commit and push on a feature branch named feature/issue-${issue.number}-${slugify(issue.title)}.`,
        `  6. Open a pull request.`,
        ``,
        `When done, reply with ONLY a single JSON object (no prose, no markdown). Start your reply with '{' and finish with '}':`,
        `{"filesChanged":["..."],"testCommand":"node --test ...","prUrl":"https://github.com/..."}`,
      ].join("\n");
      state.implementation = await runLlmAgent<ImplementationResult>({
        name: "implementation",
        ctx: implCtx,
        systemPrompt: `You are the implementation agent for the multi-agent software factory.\n\n${skillBody}\n\nYou MUST satisfy every acceptance criterion stated in the issue body.`,
        userPrompt,
        parse: parseImplementationJson,
        extraTools: [
          ...defaultTools(implCtx),
          commitAndPushTool(implCtx),
          openPullRequestTool(implCtx, this.remotePath),
        ],
      });
      state.implementation = {
        ...state.implementation,
        issueNumber: issue.number,
        branch: state.implementation.branch || `feature/issue-${issue.number}-${slugify(issue.title)}`,
      };
    } else {
      const implAgent = new ImplementationAgent(implCtx, this.remotePath);
      state.implementation = await implAgent.run();
    }
    this.emit("implementation", { issueNumber: issue.number, result: state.implementation });

    // 4. Review PR
    await this.prepareReviewArtifacts(state.implementation);
    const reviewCtx = baseCtx("reviewPr");
    const reviewAgent = new ReviewPrAgent(reviewCtx);
    state.review = await reviewAgent.run();
    this.emit("review", { issueNumber: issue.number, result: state.review });

    // 5. Verify behavior only after review approval.
    if (state.review.verdict === "APPROVE") {
      const verify = await new VerifyBehaviorAgent(implCtx, "verify").run();
      state.implementation = { ...state.implementation, behaviorVerification: verify };
      this.emit("verify", { issueNumber: issue.number, result: verify });

      // 6. Merge is gated on review approval; verify-behavior is advisory.
      //    Background: UI/visual issues (three.js games, dashboards,
      //    anything that needs a real browser) frequently return
      //    "not-verified" in LLM-runner environments even when the
      //    implementation is correct. Treating verify as a hard gate
      //    makes the merge step unusable for entire categories of
      //    issues. Only "blocked" is treated as a hard veto — every
      //    other status (verified / partially-verified / not-verified)
      //    is best-effort and merges proceed with a logged note.
      const verifyBlocksMerge = verify.status === "blocked";
      if (verifyBlocksMerge) {
        this.logger.warn(
          `skipping merge for issue #${issue.number} ` +
          `(review=APPROVE but verify.status=blocked)`,
        );
      } else if (this.remotePath && state.implementation.prUrl) {
        if (verify.status !== "verified") {
          this.logger.info(
            `merging with advisory verify for issue #${issue.number} ` +
            `(review=APPROVE, verify=${verify.status})`,
          );
        }
        await mergePullRequest({
          workdir: this.workdir,
          remotePath: this.remotePath,
          prUrl: state.implementation.prUrl,
        });
        state.merged = true;
        this.emit("merged", { issueNumber: issue.number });
      }
    }

    return state;
  }

  private async prepareReviewArtifacts(implementation: ImplementationResult): Promise<void> {
    let rawDiff = "";
    try {
      const { stdout: root } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: this.workdir });
      if (path.resolve(root.trim()) !== path.resolve(this.workdir)) throw new Error("workdir is not a repository root");
      // The factory/ directory holds the runner's own source copied into
      // the target workdir. Excluding it from the review diff prevents the
      // regex-based review rules (console.log/TODO/eval() from firing on
      // the runner's own code. Recursive directory exclusion is implicit
      // in git pathspec — naming the directory is enough.
      const { stdout } = await exec("git", [
        "diff",
        "--unified=3",
        `origin/${this.repoMeta.defaultBranch}...HEAD`,
        "--",
        ":!factory",
      ], { cwd: this.workdir, maxBuffer: 16 * 1024 * 1024 });
      rawDiff = stdout;
    } catch (err) {
      this.logger.warn(`review diff unavailable: ${String(err).split("\n")[0]}`);
    }
    await fs.writeFile(path.join(this.workdir, "pr_diff.txt"), annotateDiff(rawDiff), "utf-8");
    await fs.writeFile(path.join(this.workdir, "pr_description.txt"), implementation.comment || "", "utf-8");
  }

  private async executeTriage(
    issue: Issue,
    skillBody: string,
    runId: string,
    mode: AgentMode,
  ): Promise<TriageResult> {
    const ctx: AgentContext = {
      repo: this.repoMeta,
      issue,
      logger: this.logger,
      skillBody,
      runId,
    };
    if (mode !== "llm") {
      return new TriageAgent(ctx).run();
    }
    const result = await runLlmAgent<TriageResult>({
      name: "triage",
      ctx,
      systemPrompt: `You are the triage agent for the multi-agent software factory.\n\n${skillBody}\n\nBias toward action: when the issue has concrete acceptance criteria and a bounded scope, classify as "Ready to implement". Only classify as "Needs info" when truly ambiguous; "Wait to implement" only when the request is off-topic or duplicates existing work.`,
      userPrompt: [
        `Triage issue #${issue.number}: ${issue.title}`,
        ``,
        `Body / acceptance criteria:`,
        issue.body,
        ``,
        `Use the read_file tool to inspect the repository when useful. Return only one JSON object:`,
        `{"state":"Ready to implement","label":"ready-to-implement","remove_labels":["ready-to-spec","needs-info","wait-to-implement","spec-ready-for-review"],"comment":"Triage decision: Ready to implement."}`,
      ].join("\n"),
      parse: parseTriageJson,
    });
    const tools = defaultTools(ctx);
    await tools.find((tool) => tool.name === "update_issue_labels")!.execute({
      add: [result.label],
      remove: result.remove_labels,
    }, ctx);
    await tools.find((tool) => tool.name === "post_issue_comment")!.execute({ body: result.comment }, ctx);
    return result;
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
    const reviewSkill = await this.loader.load("review-pr");
    const ctx: AgentContext = {
      repo: this.repoMeta,
      issue,
      logger: this.logger,
      skillBody: skill.body,
      runId: newRunId(),
    };
    const agent = new ImproveReviewPrAgent(ctx, this.remotePath, reviewSkill.body);
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

/** Parse the LLM's text output into an ImplementationResult. */
function parseImplementationJson(text: string): ImplementationResult {
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
          if (obj && typeof obj === "object" && (Array.isArray(obj.filesChanged) || typeof obj.prUrl === "string")) {
            last = obj;
          }
        } catch {}
        start = -1;
      }
    }
  }
  if (!last) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { last = JSON.parse(m[0]); } catch {} }
  }
  if (!last) throw new Error("LLM did not return a valid implementation JSON:\n" + text.slice(0, 800));
  const filesChanged: string[] = Array.isArray(last.filesChanged)
    ? last.filesChanged.map(String)
    : [];
  // Soft-warn on legacy feature-N.* paths. Old fixtures/issues may have
  // committed under that scheme; we don't reject them (don't break
  // existing runs), but we surface the deviation so operators can spot
  // when a prompt regression has reverted to the legacy pattern.
  for (const f of filesChanged) {
    if (/feature-\d+\.\w+$/.test(f)) {
      // eslint-disable-next-line no-console
      console.warn(`[factory] implementation LLM produced legacy path '${f}'; consider migrating to slug-based naming`);
    }
  }
  return {
    issueNumber: 0,
    branch: typeof last.branch === "string" ? last.branch : "",
    commitSha: typeof last.commitSha === "string" ? last.commitSha : "",
    prUrl: typeof last.prUrl === "string" ? last.prUrl : "",
    prNumber: 0,
    filesChanged,
    validation: [],
    comment: typeof last.comment === "string" ? last.comment : "",
  };
}

function annotateDiff(patch: string): string {
  const output: string[] = [];
  let oldLine: number | null = null;
  let newLine: number | null = null;
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      output.push(raw);
    } else if (raw.startsWith("--- ") || raw.startsWith("+++ ") || oldLine === null || newLine === null) {
      output.push(raw);
    } else if (raw.startsWith("-")) {
      output.push(`[OLD:${oldLine}] ${raw.slice(1)}`);
      oldLine += 1;
    } else if (raw.startsWith("+")) {
      output.push(`[NEW:${newLine}] ${raw.slice(1)}`);
      newLine += 1;
    } else if (raw.startsWith(" ")) {
      output.push(`[OLD:${oldLine},NEW:${newLine}] ${raw.slice(1)}`);
      oldLine += 1;
      newLine += 1;
    } else {
      output.push(raw);
    }
  }
  return output.join("\n");
}
