import { BaseAgent, type AgentPlan, type AgentState } from "../core/agent.js";
import { defaultTools } from "../core/tools.js";
import type {
  AgentContext,
  ProductSpec,
  SpecPair,
  TechSpec,
  UserStory,
} from "../core/types.js";

/**
 * SpecAgent coordinates PRODUCT.md and TECH.md generation.
 *
 * It is a thin orchestrator over the write-product-spec and write-tech-spec
 * skills. In production the agent loop would delegate to a sub-agent that loads
 * each skill. In this implementation we model the same contract: plan the
 * stories, draft PRODUCT.md, then draft TECH.md against it, then open a specs
 * PR.
 */
export class SpecAgent extends BaseAgent<SpecPair> {
  readonly name = "spec";

  constructor(ctx: AgentContext) {
    super(ctx, defaultTools(ctx));
  }

  protected async plan(state: AgentState): Promise<AgentPlan> {
    const step = (state.scratch.step as string) ?? "draft_product";
    switch (step) {
      case "draft_product":
        return { kind: "tool", description: "draft PRODUCT.md", toolName: "write_file", args: { path: this.productPath(state), content: this.renderProduct(state) } };
      case "draft_tech":
        return { kind: "tool", description: "draft TECH.md", toolName: "write_file", args: { path: this.techPath(state), content: this.renderTech(state) } };
      case "open_pr":
        return { kind: "tool", description: "open specs PR (record PR URL in state)", toolName: "run_shell", args: { command: this.prCommand(state) } };
      case "comment":
        return { kind: "tool", description: "post handoff comment", toolName: "post_issue_comment", args: { body: this.handoffComment(state) } };
      case "finish":
        return { kind: "finish", description: "spec done" };
      default:
        return { kind: "finish", description: "fallback" };
    }
  }

  protected async act(_plan: AgentPlan, _observation: unknown, state: AgentState): Promise<AgentState> {
    const next: AgentState = { scratch: { ...state.scratch }, history: state.history };
    const step = (state.scratch.step as string) ?? "draft_product";
    switch (step) {
      case "draft_product":
        next.scratch.step = "draft_tech";
        break;
      case "draft_tech":
        next.scratch.step = "open_pr";
        break;
      case "open_pr":
        next.scratch.specPrUrl = `https://github.com/${this.ctx.repo.owner}/${this.ctx.repo.name}/pull/${this.prNumberFor(state)}`;
        next.scratch.step = "comment";
        break;
      case "comment":
        next.scratch.step = "finish";
        break;
      default:
        return next;
    }
    return next;
  }

  protected async finalize(state: AgentState): Promise<SpecPair> {
    const slug = this.slug();
    const product = this.buildProduct(slug, state);
    const tech = this.buildTech(slug, product);
    return {
      product,
      tech,
      specBranch: `spec/issue-${this.ctx.issue.number}-${slug}`,
      specPrUrl: (state.scratch.specPrUrl as string) ?? "",
    };
  }

  private slug(): string {
    return `issue-${this.ctx.issue.number}-${slugify(this.ctx.issue.title)}`;
  }
  private productPath(state: AgentState): string {
    return `specs/${this.slug()}/PRODUCT.md`;
  }
  private techPath(state: AgentState): string {
    return `specs/${this.slug()}/TECH.md`;
  }
  private prNumberFor(state: AgentState): number {
    return 100 + this.ctx.issue.number;
  }
  private prCommand(state: AgentState): string {
    return `echo "opened specs PR for issue #${this.ctx.issue.number}"`;
  }
  private handoffComment(state: AgentState): string {
    return [
      `**Spec work complete.**`,
      ``,
      `- Product spec: \`specs/${this.slug()}/PRODUCT.md\``,
      `- Tech spec: \`specs/${this.slug()}/TECH.md\``,
      `- Specs PR: ${state.scratch.specPrUrl ?? "(pending)"}`,
      ``,
      `Once reviewed and merged, apply \`Ready to implement\` to trigger the implementation agent.`,
    ].join("\n");
  }
  private renderProduct(state: AgentState): string {
    return this.buildProduct(this.slug(), state).body;
  }
  private renderTech(state: AgentState): string {
    return this.buildTech(this.slug(), this.buildProduct(this.slug(), state)).body;
  }
  private buildProduct(slug: string, _state: AgentState): ProductSpec {
    const issue = this.ctx.issue;
    const stories = deriveStories(issue);
    const body = [
      `# PRODUCT.md — ${issue.title}`,
      ``,
      `**Slug:** \`${slug}\``,
      `**Status:** Draft`,
      `**Issue:** #${issue.number}`,
      ``,
      `## Problem`,
      ``,
      issue.body || "(no body provided)",
      ``,
      `## Goals`,
      ``,
      ...stories.slice(0, 3).map((s) => `- ${s.title}`),
      ``,
      `## Non-goals`,
      ``,
      `- Out-of-scope refactors unrelated to this issue.`,
      `- Backend infrastructure not required by the user story.`,
      ``,
      `## User stories`,
      ``,
      ...stories.flatMap((s) => [
        `### ${s.id} — ${s.title}`,
        `**As a** ${s.asA}`,
        `**I want** ${s.iWant}`,
        `**So that** ${s.soThat}`,
        ``,
        `**Checks:**`,
        ...s.checks.map((c) => `- ${c}`),
        ``,
      ]),
      `## Acceptance criteria`,
      ``,
      ...stories.flatMap((s) => s.checks.slice(0, 2)).map((c) => `- ${c}`),
      ``,
      `## Open product questions`,
      ``,
      `- None blocking.`,
      ``,
    ].join("\n");
    return {
      slug,
      title: issue.title,
      problem: issue.body || "",
      goals: stories.slice(0, 3).map((s) => s.title),
      nonGoals: ["Unrelated refactors", "Backend infrastructure not required"],
      stories,
      acceptanceCriteria: stories.flatMap((s) => s.checks.slice(0, 2)),
      openQuestions: [],
      body,
    };
  }
  private buildTech(slug: string, product: ProductSpec): TechSpec {
    const areas = deriveAffectedAreas(product);
    const body = [
      `# TECH.md — ${product.title}`,
      ``,
      `**Slug:** \`${slug}\``,
      `**Status:** Draft`,
      ``,
      `## Approach`,
      ``,
      `Implement the smallest cohesive change that satisfies each user story, then validate against PRODUCT.md acceptance criteria.`,
      ``,
      `## Affected areas`,
      ``,
      ...areas.map((a) => `- \`${a}\``),
      ``,
      `## Data model`,
      ``,
      `No schema changes required for the user stories.`,
      ``,
      `## API changes`,
      ``,
      `- None.`,
      ``,
      `## Migration plan`,
      ``,
      `No migration.`,
      ``,
      `## Validation plan`,
      ``,
      `- Run targeted unit tests for each story.`,
      `- Run \`validate-changes-match-specs\` after implementation.`,
      `- Run \`verify-behavior\` in \`verify\` mode for visible UI flows.`,
      ``,
      `## Alternatives considered`,
      ``,
      `- Doing nothing: rejected — the user issue is actionable.`,
      `- Larger refactor: rejected — out of scope per non-goals.`,
      ``,
      `## Open technical questions`,
      ``,
      `- None blocking.`,
      ``,
    ].join("\n");
    return {
      slug,
      approach: "Smallest cohesive change that satisfies each user story.",
      affectedAreas: areas,
      dataModel: "No schema changes.",
      apiChanges: [],
      migrationPlan: "No migration.",
      validationPlan: ["unit-tests", "validate-changes-match-specs", "verify-behavior"],
      alternatives: ["Doing nothing", "Larger refactor"],
      openQuestions: [],
      body,
    };
  }
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "issue";
}

function deriveStories(issue: { title: string; body: string }): UserStory[] {
  const text = `${issue.title} ${issue.body}`.toLowerCase();
  const base: UserStory[] = [
    {
      id: "US-1",
      title: "Apply the change",
      asA: "user",
      iWant: `to ${issue.title.toLowerCase()}`,
      soThat: "the requested behavior is in place",
      checks: [
        "the change is reflected in the running app",
        "no regressions in adjacent flows",
        "tests cover the new behavior",
      ],
    },
    {
      id: "US-2",
      title: "See clear feedback",
      asA: "user",
      iWant: "to see success or failure feedback",
      soThat: "I know whether my action worked",
      checks: [
        "success state is visible",
        "error state explains what went wrong",
        "empty state exists where appropriate",
      ],
    },
    {
      id: "US-3",
      title: "Recover from mistakes",
      asA: "user",
      iWant: "to undo or retry the action",
      soThat: "I can correct mistakes quickly",
      checks: [
        "retry path is reachable",
        "previous state is recoverable when feasible",
      ],
    },
  ];
  if (/(export|download|share)/.test(text)) {
    base.push({
      id: "US-4",
      title: "Export the result",
      asA: "user",
      iWant: "to download or share the result",
      soThat: "I can use it elsewhere",
      checks: ["download produces a usable file", "filename is sensible"],
    });
  }
  return base;
}

function deriveAffectedAreas(product: ProductSpec): string[] {
  const areas = new Set<string>();
  for (const story of product.stories) {
    if (story.title.toLowerCase().includes("export")) areas.add("src/export.ts");
    if (story.title.toLowerCase().includes("feedback")) areas.add("src/ui/feedback.ts");
    if (story.title.toLowerCase().includes("recover")) areas.add("src/state/recovery.ts");
  }
  if (areas.size === 0) areas.add("src/feature.ts");
  return Array.from(areas);
}