import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ConsoleLogger } from "../core/log.js";
import { SkillLoader } from "../core/skill.js";
import { newRunId } from "../core/agent.js";
import {
    ALL_FACTORY_LABELS,
    type AgentContext,
    type FactoryIssueState,
    type Issue,
    type ImplementationResult,
    type TriageLabel,
    type TriageResult,
    type TriageState,
} from "../core/types.js";
import type { AgentMode } from "../core/llm-agent.js";
import { TriageAgent } from "../agents/triage.js";
import { SpecAgent } from "../agents/spec.js";
import { slugify } from "../agents/spec.js";
import { ImplementationAgent } from "../agents/implementation.js";
import { ReviewPrAgent } from "../agents/review-pr.js";
import { VerifyBehaviorAgent } from "../agents/verify-behavior.js";
import { ImproveReviewPrAgent } from "../agents/improve-review-pr.js";
import { mergePullRequest } from "../github/git.js";
import { runLlmAgent, resolveAgentMode } from "../core/llm-agent.js";
import { commitAndPushTool, defaultTools, openPullRequestTool } from "../core/tools.js";

const exec = promisify(execFile);

/**
 * FactoryOrchestrator — wires the six agents into a complete pipeline.
 *
 * The state machine is keyed by the issue's current GitHub label. Each
 * stage runs only when the label says it should, writes the next label
 * when it finishes, and routes the issue forward. The label is the
 * single source of truth — the daemon restarts cleanly from wherever
 * the label indicates.
 *
 *   (no factory label)   → triage
 *   ready-to-spec        → spec            → ready-to-implement | split
 *   ready-to-implement   → implementation  → review-needed
 *   review-needed        → review          → ready-to-merge | changes-requested
 *   changes-requested    → implementation  (loop with review feedback)
 *   ready-to-merge       → verify          → verified | verify-failed
 *   verify-failed        → implementation  (loop with verify feedback)
 *   verified             → merge           (labels cleared)
 *
 * Spec can split an issue into N sub-issues: the parent gets a
 * "split-into-N" comment and the sub-issues are created on GitHub via
 * `gh issue create`. The factory never assumes a parent can be both
 * split and implemented in the same cycle.
 *
 * Stages always run in fixed order — no stage may skip another. Verify
 * is a real merge gate: `verified` and `partially-verified` advance;
 * `not-verified`, `blocked`, and `not-reproduced` loop back to
 * implementation with the verify report attached as feedback context.
 */
export class FactoryOrchestrator extends EventEmitter {
    private readonly logger = new ConsoleLogger({ orchestrator: "factory" });
    private readonly loader: SkillLoader;
    private readonly state = new Map<number, FactoryIssueState>();
    private readonly workdir: string;
    private readonly remotePath: string;
    private readonly repoMeta: {
        owner: string;
        name: string;
        defaultBranch: string;
        workdir: string;
    };

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

    /** Runs only triage. */
    async runTriage(issue: Issue): Promise<FactoryIssueState> {
        const runId = newRunId();
        const mode = resolveAgentMode();
        this.logger.info(`start triage for issue #${issue.number} runId=${runId} mode=${mode}`);
        const skill = await this.loader.load("triage");
        const state: FactoryIssueState = { issue, merged: false };
        this.state.set(issue.number, state);
        state.triage = await this.executeTriage(issue, skill.body, runId, mode);
        this.emit("triage", { issueNumber: issue.number, result: state.triage });
        // Write the triage label so the next poll knows the issue is
        // classified. Skip label writes for the two terminal states.
        if (
            state.triage.state !== "Wait to implement" &&
            state.triage.state !== "Needs info"
        ) {
            await writeLabel(issue, state.triage.label);
        }
        return state;
    }

    /**
     * Run the state machine for an issue from where its current label
     * says we should resume. Each stage writes the next label and
     * returns; the daemon picks the issue up again on the next poll
     * if there's more pipeline to do.
     */
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

        const startLabel = await readIssueLabel(issue);
        this.logger.info(
            `issue #${issue.number} resume-from label=${startLabel ?? "(none)"}`,
        );

        // The orchestrator runs stages in fixed order, stopping at the
        // first terminal state. After every stage it writes the next
        // label so the daemon can resume from the right place after a
        // crash. A single call still advances the issue all the way to
        // merge (or a hard stop like wait-to-implement / needs-info).
        let currentLabel: TriageLabel | null = startLabel;

        for (;;) {
            // Stage 1 — Triage. Only when no label is set.
            if (currentLabel === null) {
                state.triage = await this.executeTriage(
                    issue,
                    skillBodies.triage.body,
                    runId,
                    mode,
                );
                this.emit("triage", { issueNumber: issue.number, result: state.triage });
                if (
                    state.triage.state === "Wait to implement" ||
                    state.triage.state === "Needs info"
                ) {
                    await writeLabel(issue, state.triage.label);
                    return state;
                }
                await writeLabel(issue, state.triage.label);
                currentLabel = state.triage.label;
                continue;
            }

            // Stage 2 — Spec. Only when the label says so.
            if (currentLabel === "ready-to-spec") {
                const specAgent = new SpecAgent(baseCtx("spec"));
                state.specs = await specAgent.run();
                this.emit("spec", { issueNumber: issue.number, result: state.specs });
                const split = (state.specs as any)?.splitInto as
                    | Array<{ title: string; body: string }>
                    | undefined;
                if (split && split.length > 0) {
                    await this.queueSubIssues(issue, split);
                    await writeLabel(issue, "ready-to-implement");
                    this.logger.info(
                        `spec split #${issue.number} into ${split.length} sub-issues`,
                    );
                    return state;
                }
                await writeLabel(issue, "ready-to-implement");
                currentLabel = "ready-to-implement";
                continue;
            }

            // Stage 3 — Implementation. Triggered by ready-to-implement
            // (initial) or by changes-requested / verify-failed (loops).
            if (needsImplementation(currentLabel)) {
                const feedback = buildImplementationFeedback(state);
                const implCtx = baseCtx("implementation");
                state.implementation = await this.runImplementationStage(
                    issue,
                    implCtx,
                    mode,
                    skillBodies.implementation.body,
                    feedback,
                );
                this.emit("implementation", {
                    issueNumber: issue.number,
                    result: state.implementation,
                });
                await writeLabel(issue, "review-needed");
                currentLabel = "review-needed";
                continue;
            }

            // Stages 4/5/6 — Review, Verify, Merge, all in fixed order.
            if (
                currentLabel === "review-needed" ||
                currentLabel === "changes-requested" ||
                currentLabel === "ready-to-merge" ||
                currentLabel === "verify-failed" ||
                currentLabel === "verified"
            ) {
                const next = await this.runReviewVerifyMerge(
                    issue,
                    state,
                    baseCtx,
                );
                if (next === "done") return state;
                currentLabel = next;
                continue;
            }

            // Unknown label (e.g. user-mutated "needs-info") — exit cleanly.
            this.logger.info(
                `issue #${issue.number} stops at label=${currentLabel} (no further work)`,
            );
            return state;
        }
    }

    /**
     * Run the review → verify → merge tail in a single call. Returns
     * the next label for the caller to feed back into the dispatcher,
     * or "done" when the issue has been merged.
     */
    private async runReviewVerifyMerge(
        issue: Issue,
        state: FactoryIssueState,
        baseCtx: (k: "reviewPr" | "verifyBehavior" | "implementation") => AgentContext,
    ): Promise<TriageLabel | "done"> {
        // Review — required step before verify.
        if (!state.review) {
            const skillBodies = {
                reviewPr: await this.loader.load("review-pr"),
                verifyBehavior: await this.loader.load("verify-behavior"),
            };
            await this.prepareReviewArtifacts(state.implementation!);
            const reviewAgent = new ReviewPrAgent(baseCtx("reviewPr"));
            state.review = await reviewAgent.run();
            this.emit("review", { issueNumber: issue.number, result: state.review });
            if (state.review.verdict === "REJECT") {
                await writeLabel(issue, "changes-requested");
                this.logger.info(
                    `review REJECT on #${issue.number} → changes-requested (loop to impl)`,
                );
                return "changes-requested";
            }
            await writeLabel(issue, "ready-to-merge");
            this.logger.info(
                `review APPROVE on #${issue.number} → ready-to-merge`,
            );
            return "ready-to-merge";
        }

        // Verify — required gate before merge.
        if (!state.implementation?.behaviorVerification) {
            const verify = await new VerifyBehaviorAgent(
                baseCtx("implementation"),
                "verify",
            ).run();
            state.implementation = {
                ...state.implementation!,
                behaviorVerification: verify,
            };
            this.emit("verify", { issueNumber: issue.number, result: verify });
            const verifyOk =
                verify.status === "verified" ||
                verify.status === "partially-verified";
            if (!verifyOk) {
                await writeLabel(issue, "verify-failed");
                this.logger.warn(
                    `verify ${verify.status} on #${issue.number} → verify-failed (loop to impl)`,
                );
                return "verify-failed";
            }
            await writeLabel(issue, "verified");
            this.logger.info(`verify ${verify.status} on #${issue.number} → verified`);
            return "verified";
        }

        // Merge — only after verified.
        if (state.implementation?.prUrl && this.remotePath) {
            try {
                await mergePullRequest({
                    workdir: this.workdir,
                    remotePath: this.remotePath,
                    prUrl: state.implementation.prUrl,
                });
                state.merged = true;
                this.emit("merged", { issueNumber: issue.number });
            } catch (err) {
                this.logger.warn(
                    `merge failed for #${issue.number}: ${String(err).split("\n")[0]}`,
                );
            }
        }
        await clearLabels(issue);
        return "done";
    }

    /**
     * Implementation stage. In LLM mode, builds a prompt that includes
     * any prior review/verify feedback so the agent doesn't restart from
     * scratch. In stub mode, just runs the deterministic implementation
     * agent.
     */
    private async runImplementationStage(
        issue: Issue,
        ctx: AgentContext,
        mode: AgentMode,
        skillBody: string,
        feedback: string,
    ): Promise<ImplementationResult> {
        if (mode === "stub") {
            return new ImplementationAgent(ctx, this.remotePath).run();
        }
        const userPrompt = [
            `Implement issue #${issue.number}: ${issue.title}`,
            ``,
            `Body / acceptance criteria:`,
            issue.body,
            ``,
            `Repo workdir: ${this.workdir}`,
            ``,
            feedback,
            `Use the available tools (read_file, write_file, run_shell, commit_and_push, open_pull_request) to:`,
            `  1. Inspect the existing repo structure (run_shell: ls).`,
            `  2. Choose descriptive kebab-case file paths derived from the issue title`,
            `     (e.g. src/cosmic-core.js, tests/cosmic-core.test.js).`,
            `     NEVER use 'feature-<number>.*' — that hardcodes the id and gets REJECTed by review-pr.`,
            `  3. Implement the smallest cohesive change that satisfies every acceptance criterion.`,
            `  4. Write a real Node.js test using node:test + node:assert that covers the happy path AND every error path. Run it with node --test until it passes.`,
            `  5. Commit and push on a feature branch named feature/issue-${issue.number}-${slugify(issue.title)}.`,
            `  6. Open a pull request.`,
            ``,
            `When done, reply with ONLY a single JSON object (no prose, no markdown). Start your reply with '{' and finish with '}':`,
            `{"filesChanged":["..."],"testCommand":"node --test ...","prUrl":"https://github.com/..."}`,
        ].join("\n");
        const result = await runLlmAgent<ImplementationResult>({
            name: "implementation",
            ctx,
            systemPrompt: `You are the implementation agent for the multi-agent software factory.\n\n${skillBody}\n\nYou MUST satisfy every acceptance criterion stated in the issue body.`,
            userPrompt,
            parse: parseImplementationJson,
            extraTools: [
                ...defaultTools(ctx),
                commitAndPushTool(ctx),
                openPullRequestTool(ctx, this.remotePath),
            ],
        });
        return {
            ...result,
            issueNumber: issue.number,
            branch:
                result.branch ||
                `feature/issue-${issue.number}-${slugify(issue.title)}`,
        };
    }

    /**
     * Create sub-issues from a spec split decision. Sub-issues carry
     * the `ready-to-implement` label so the next daemon poll picks them
     * up automatically.
     */
    private async queueSubIssues(
        parent: Issue,
        split: Array<{ title: string; body: string }>,
    ): Promise<void> {
        const repo = process.env.FACTORY_GH_REPO;
        const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
        if (!repo || !token) {
            this.logger.warn(
                `spec split into ${split.length} sub-issues but no GH_TOKEN/FACTORY_GH_REPO configured; skipping queue`,
            );
            return;
        }
        for (const sub of split) {
            try {
                await exec(
                    "gh",
                    [
                        "issue",
                        "create",
                        "--repo",
                        repo,
                        "--title",
                        sub.title,
                        "--body",
                        sub.body,
                        "--label",
                        "ready-to-implement",
                    ],
                    { env: { ...process.env, GH_TOKEN: token } },
                );
                this.logger.info(`queued sub-issue: ${sub.title}`);
            } catch (err) {
                this.logger.warn(
                    `failed to create sub-issue "${sub.title}": ${String(err).split("\n")[0]}`,
                );
            }
        }
    }

    private async prepareReviewArtifacts(implementation: ImplementationResult): Promise<void> {
        let rawDiff = "";
        try {
            const { stdout: root } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: this.workdir });
            if (path.resolve(root.trim()) !== path.resolve(this.workdir)) {
                throw new Error("workdir is not a repository root");
            }
            const { stdout } = await exec(
                "git",
                [
                    "diff",
                    "--unified=3",
                    `origin/${this.repoMeta.defaultBranch}...HEAD`,
                ],
                { cwd: this.workdir, maxBuffer: 16 * 1024 * 1024 },
            );
            rawDiff = stdout;
        } catch (err) {
            this.logger.warn(`review diff unavailable: ${String(err).split("\n")[0]}`);
        }
        await fs.writeFile(path.join(this.workdir, "pr_diff.txt"), annotateDiff(rawDiff), "utf-8");
        await fs.writeFile(
            path.join(this.workdir, "pr_description.txt"),
            implementation.comment || "",
            "utf-8",
        );
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
        await tools.find((tool) => tool.name === "update_issue_labels")!.execute(
            {
                add: [result.label],
                remove: result.remove_labels,
            },
            ctx,
        );
        await tools.find((tool) => tool.name === "post_issue_comment")!.execute(
            { body: result.comment },
            ctx,
        );
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

    /** Persists all per-issue state to disk under <workdir>/factory/state/<n>.json. */
    async persist(): Promise<void> {
        const outDir = path.join(this.workdir, "factory", "state");
        await fs.mkdir(outDir, { recursive: true });
        for (const [n, state] of this.state) {
            await fs.writeFile(
                path.join(outDir, `${n}.json`),
                JSON.stringify(state, null, 2),
                "utf-8",
            );
        }
    }
}

/* -------------------------------------------------------------------------- */
/* Label + state-machine helpers                                              */
/* -------------------------------------------------------------------------- */

const STAGE_FOR_LABEL: Record<TriageLabel, number> = {
    "ready-to-implement": 1,
    "ready-to-spec": 1,
    "spec-ready-for-review": 1,
    "needs-info": 0,
    "wait-to-implement": 0,
    "review-needed": 2,
    "ready-to-merge": 3,
    "verified": 4,
    "verify-failed": 2,
    "changes-requested": 2,
};

function needsImplementation(label: TriageLabel): boolean {
    return label === "ready-to-implement" || label === "changes-requested" || label === "verify-failed";
}

function needsSpec(label: TriageLabel | null, _triageState: TriageState): boolean {
    return label === "ready-to-spec";
}

function synthTriageFromLabel(label: TriageLabel): TriageResult {
    const stateMap: Partial<Record<TriageLabel, TriageState>> = {
        "ready-to-implement": "Ready to implement",
        "ready-to-spec": "Ready to spec",
        "spec-ready-for-review": "Ready to spec",
        "review-needed": "Ready to implement",
        "ready-to-merge": "Ready to implement",
        "verified": "Ready to implement",
        "verify-failed": "Ready to implement",
        "changes-requested": "Ready to implement",
        "needs-info": "Needs info",
        "wait-to-implement": "Wait to implement",
    };
    return {
        state: stateMap[label] ?? "Ready to implement",
        label,
        remove_labels: [],
        comment: `Resumed from label ${label}`,
    };
}

function buildImplementationFeedback(state: FactoryIssueState): string {
    const lines: string[] = [];
    if (state.review && state.review.verdict === "REJECT") {
        lines.push(
            `Review REJECTED the previous attempt. Body:`,
            state.review.body || "(no body)",
        );
        for (const c of state.review.comments ?? []) {
            lines.push(`- ${c.path}:${c.line}  ${c.body}`);
        }
        lines.push(
            ``,
            `Address every review comment before opening a new PR. Do NOT just re-submit — the diff must be materially different.`,
        );
    }
    if (state.implementation?.behaviorVerification) {
        const v = state.implementation.behaviorVerification;
        lines.push(
            ``,
            `Verify-behavior ran with status=${v.status}; channel=${v.channel}. Notes: ${v.notes || "(none)"}`,
        );
        if (v.ozRunUrl) lines.push(`oz run: ${v.ozRunUrl}`);
        for (const ev of v.evidence ?? []) {
            lines.push(`- [${ev.kind}] ${ev.caption} → ${ev.path}`);
        }
        if (v.status !== "verified" && v.status !== "partially-verified") {
            lines.push(
                `The verify step did not pass. Read the notes and the evidence; fix the underlying issue, not the symptoms.`,
            );
        }
    }
    if (lines.length === 0) return "Fresh implementation pass; no prior feedback.";
    return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* Label I/O (best-effort, no-op without `gh`)                                */
/* -------------------------------------------------------------------------- */

async function readIssueLabel(issue: Issue): Promise<TriageLabel | null> {
    // 1. In-memory labels (handy for fixtures, local file loads, and tests).
    for (const name of issue.labels ?? []) {
        if (ALL_FACTORY_LABELS.includes(name as TriageLabel)) {
            return name as TriageLabel;
        }
    }
    // 2. GitHub via `gh` CLI.
    const repo = process.env.FACTORY_GH_REPO;
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!repo || !token) return null;
    try {
        const { stdout } = await exec(
            "gh",
            [
                "issue",
                "view",
                String(issue.number),
                "--repo",
                repo,
                "--json",
                "labels",
                "--jq",
                ".labels[].name",
            ],
            { env: { ...process.env, GH_TOKEN: token } },
        );
        for (const line of stdout.split(/\r?\n/)) {
            const name = line.trim();
            if (ALL_FACTORY_LABELS.includes(name as TriageLabel)) {
                return name as TriageLabel;
            }
        }
        return null;
    } catch {
        return null;
    }
}

async function writeLabel(issue: Issue, label: TriageLabel): Promise<void> {
    const repo = process.env.FACTORY_GH_REPO;
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!repo || !token) return;
    try {
        const env = { ...process.env, GH_TOKEN: token };
        await exec("gh", ["label", "create", label, "--repo", repo, "--color", "5319E7", "--force"], { env });
        for (const stale of ALL_FACTORY_LABELS) {
            if (stale === label) continue;
            try {
                await exec(
                    "gh",
                    ["issue", "edit", String(issue.number), "--repo", repo, "--remove-label", stale],
                    { env },
                );
            } catch { /* label not present */ }
        }
        await exec(
            "gh",
            ["issue", "edit", String(issue.number), "--repo", repo, "--add-label", label],
            { env },
        );
    } catch (err) {
        // best-effort
    }
}

async function clearLabels(issue: Issue): Promise<void> {
    const repo = process.env.FACTORY_GH_REPO;
    const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (!repo || !token) return;
    try {
        for (const label of ALL_FACTORY_LABELS) {
            try {
                await exec(
                    "gh",
                    ["issue", "edit", String(issue.number), "--repo", repo, "--remove-label", label],
                    { env: { ...process.env, GH_TOKEN: token } },
                );
            } catch { /* ok */ }
        }
    } catch { /* best-effort */ }
}

/* -------------------------------------------------------------------------- */
/* Parsers (LLM output → typed result)                                       */
/* -------------------------------------------------------------------------- */

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
        if (m) {
            try {
                last = JSON.parse(m[0]);
            } catch {}
        }
    }
    if (!last) throw new Error("LLM did not return a valid implementation JSON:\n" + text.slice(0, 800));
    return {
        issueNumber: 0,
        branch: typeof last.branch === "string" ? last.branch : "",
        commitSha: typeof last.commitSha === "string" ? last.commitSha : "",
        prUrl: typeof last.prUrl === "string" ? last.prUrl : "",
        prNumber: 0,
        filesChanged: Array.isArray(last.filesChanged) ? last.filesChanged.map(String) : [],
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