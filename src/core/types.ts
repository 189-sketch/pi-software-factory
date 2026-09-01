/**
 * Core types for the pi-framework multi-agent software factory.
 *
 * Each agent is an independent unit that loads one skill file and produces a
 * structured result. The orchestrator wires the agents together via a state
 * machine keyed by GitHub issue labels.
 */

/** The four canonical triage-readiness states. */
export type TriageState =
  | "Ready to implement"
  | "Ready to spec"
  | "Needs info"
  | "Wait to implement";

/** Triage label as applied on the GitHub issue. */
export type TriageLabel =
  | "ready-to-implement"
  | "ready-to-spec"
  | "needs-info"
  | "wait-to-implement"
  | "spec-ready-for-review";

/** Triage agent output. Mirrors the demo's JSON contract exactly. */
export interface TriageResult {
  state: TriageState;
  label: TriageLabel;
  remove_labels: TriageLabel[];
  comment: string;
}

/** A captured issue, normalized to what the agents need. */
export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: TriageLabel[];
  author: string;
  url: string;
  createdAt: string;
  comments: IssueComment[];
}

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

/** PRODUCT.md frontmatter + body. */
export interface ProductSpec {
  slug: string;
  title: string;
  problem: string;
  goals: string[];
  nonGoals: string[];
  stories: UserStory[];
  acceptanceCriteria: string[];
  openQuestions: string[];
  body: string;
}

export interface UserStory {
  id: string;
  title: string;
  asA: string;
  iWant: string;
  soThat: string;
  checks: string[];
}

/** TECH.md frontmatter + body. */
export interface TechSpec {
  slug: string;
  approach: string;
  affectedAreas: string[];
  dataModel: string;
  apiChanges: string[];
  migrationPlan: string;
  validationPlan: string[];
  alternatives: string[];
  openQuestions: string[];
  body: string;
}

/** A spec pair produced by the spec agent. */
export interface SpecPair {
  product: ProductSpec;
  tech: TechSpec;
  specBranch: string;
  specPrUrl: string;
}

/** Implementation agent output. */
export interface ImplementationResult {
  issueNumber: number;
  branch: string;
  commitSha: string;
  prUrl: string;
  prNumber: number;
  filesChanged: string[];
  validation: ValidationResult[];
  specAlignment?: SpecAlignmentResult;
  behaviorVerification?: BehaviorVerificationResult;
  comment: string;
}

export interface ValidationResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SpecAlignmentResult {
  matched: string[];
  mismatched: string[];
  notes: string;
}

export type BehaviorMode = "reproduce" | "verify";

export interface BehaviorVerificationResult {
  mode: BehaviorMode;
  status: "verified" | "partially-verified" | "not-verified" | "blocked"
        | "confirmed" | "partially-confirmed" | "not-reproduced";
  channel: "browser" | "desktop" | "hybrid";
  ozRunUrl: string;
  evidence: EvidenceArtifact[];
  notes: string;
}

export interface EvidenceArtifact {
  kind: "video" | "screenshot";
  caption: string;
  path: string;
}

/** Review agent output. Mirrors the demo's review.json contract. */
export interface ReviewComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
}

export interface ReviewResult {
  verdict: "APPROVE" | "REJECT";
  body: string;
  comments: ReviewComment[];
}

/** Improve-review-pr agent output. */
export interface ImproveReviewResult {
  window: string;
  prsInspected: number;
  feedbackItems: { validated: number; corrected: number; refined: number; ambiguous: number };
  decision: "no_changes" | "update_review_pr" | "update_review_pr_local" | "both";
  learnings: string[];
  skillPrUrl: string | null;
  notes: string;
}

/** The factory state machine, keyed by issue number. */
export interface FactoryIssueState {
  issue: Issue;
  triage?: TriageResult;
  specs?: SpecPair;
  implementation?: ImplementationResult;
  review?: ReviewResult;
  merged: boolean;
}

/** Logger interface every agent implements. */
export interface AgentLogger {
  info(msg: string, ...rest: unknown[]): void;
  warn(msg: string, ...rest: unknown[]): void;
  error(msg: string, ...rest: unknown[]): void;
  child(bindings: Record<string, unknown>): AgentLogger;
}

export interface AgentContext {
  repo: { owner: string; name: string; defaultBranch: string; workdir: string };
  issue: Issue;
  logger: AgentLogger;
  /** Loaded SKILL.md body for this agent. */
  skillBody: string;
  /** Optional shared run id used in Oz run links. */
  runId: string;
}