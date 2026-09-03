import { BaseAgent, type AgentPlan, type AgentState } from "../core/agent.js";
import { defaultTools } from "../core/tools.js";
import type { AgentContext, ReviewComment, ReviewResult } from "../core/types.js";

const ALLOWED_PREFIXES = ["🚨 [CRITICAL]", "⚠️ [IMPORTANT]", "💡 [SUGGESTION]", "🧹 [NIT]"] as const;

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

/**
 * ReviewPrAgent reads an annotated diff and emits a structured review.json.
 *
 * Same contract as the cloud-factory demo:
 * - `verdict` ∈ {APPROVE, REJECT}
 * - `body` non-empty, leads with findings-by-severity or "no findings"
 * - `comments[]` with severity-prefixed bodies and inline coordinates
 */
export class ReviewPrAgent extends BaseAgent<ReviewResult> {
  readonly name = "review-pr";

  constructor(ctx: AgentContext) {
    super(ctx, defaultTools(ctx));
  }

  protected async plan(state: AgentState): Promise<AgentPlan> {
    const step = (state.scratch.step as string) ?? "read_diff";
    switch (step) {
      case "read_diff":
        return { kind: "tool", description: "read annotated diff", toolName: "read_file", args: { path: "pr_diff.txt" } };
      case "read_description":
        return { kind: "tool", description: "read PR description", toolName: "read_file", args: { path: "pr_description.txt" } };
      case "analyze":
        return { kind: "tool", description: "analyze diff signals", toolName: "run_shell", args: { command: "echo analyzed" } };
      case "write_review":
        return { kind: "tool", description: "persist structured review", toolName: "write_file", args: { path: "review.json", content: JSON.stringify(resultFor(state.scratch.findings), null, 2) } };
      case "finish":
        return { kind: "finish", description: "review done" };
      default:
        return { kind: "finish", description: "fallback" };
    }
  }

  protected async act(_plan: AgentPlan, observation: unknown, state: AgentState): Promise<AgentState> {
    const next: AgentState = { scratch: { ...state.scratch }, history: state.history };
    const step = (state.scratch.step as string) ?? "read_diff";
    switch (step) {
      case "read_diff":
        next.scratch.diff = extractContent(observation);
        next.scratch.step = "read_description";
        break;
      case "read_description":
        next.scratch.description = extractContent(observation);
        next.scratch.step = "analyze";
        break;
      case "analyze": {
        const findings = deriveFindings(next.scratch.diff as string);
        next.scratch.findings = findings;
        next.scratch.step = "write_review";
        break;
      }
      case "write_review":
        next.scratch.step = "finish";
        break;
      default:
        return next;
    }
    return next;
  }

  protected async finalize(state: AgentState): Promise<ReviewResult> {
    return resultFor(state.scratch.findings);
  }
}

type Finding = { severity: "CRITICAL" | "IMPORTANT" | "SUGGESTION" | "NIT"; summary: string; path: string; line: number; side: "LEFT" | "RIGHT" };

function resultFor(value: unknown): ReviewResult {
  const findings = (value as Finding[] | undefined) ?? [];
  const comments: ReviewComment[] = findings
    .filter((finding) => finding.path && finding.line > 0)
    .map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: finding.side,
      body: `${ALLOWED_PREFIXES[severityIndex(finding.severity)]} ${finding.summary}`,
    }));
  return { verdict: verdictFor(findings), body: buildBody(findings), comments };
}

function severityIndex(s: string): number {
  return ["CRITICAL", "IMPORTANT", "SUGGESTION", "NIT"].indexOf(s);
}

function verdictFor(findings: Array<{ severity: string }>): "APPROVE" | "REJECT" {
  if (findings.some((f) => f.severity === "CRITICAL" || f.severity === "IMPORTANT")) {
    return "REJECT";
  }
  return "APPROVE";
}

function buildBody(findings: Array<{ severity: string; summary: string }>): string {
  if (findings.length === 0) return "No findings — implementation looks good.";
  const counts = findings.reduce<Record<string, number>>((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const lines = [
    `Found: ${counts.CRITICAL ?? 0} critical, ${counts.IMPORTANT ?? 0} important, ${counts.SUGGESTION ?? 0} suggestions, ${counts.NIT ?? 0} nits.`,
    ``,
    ...findings.map((f) => `- **${f.severity}** — ${f.summary}`),
  ];
  return lines.join("\n");
}

function deriveFindings(diff: string): Array<{ severity: "CRITICAL" | "IMPORTANT" | "SUGGESTION" | "NIT"; summary: string; path: string; line: number; side: "LEFT" | "RIGHT" }> {
  const findings: Array<{ severity: "CRITICAL" | "IMPORTANT" | "SUGGESTION" | "NIT"; summary: string; path: string; line: number; side: "LEFT" | "RIGHT" }> = [];
  const lines = diff.split("\n");
  let currentPath = "";
  for (const line of lines) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch) {
      currentPath = fileMatch[1];
      continue;
    }
    const newMatch = line.match(/^\[NEW:(\d+)\] ?(.*)$/);
    if (newMatch && currentPath) {
      const text = newMatch[2];
      const lineNo = Number(newMatch[1]);
      if (/console\.log\(/.test(text)) {
        findings.push({ severity: "NIT", summary: `console.log left in production code (${currentPath}:${lineNo})`, path: currentPath, line: lineNo, side: "RIGHT" });
      }
      if (/TODO|FIXME/.test(text)) {
        findings.push({ severity: "IMPORTANT", summary: `TODO marker left in code (${currentPath}:${lineNo})`, path: currentPath, line: lineNo, side: "RIGHT" });
      }
      if (/eval\(|dangerouslySetInnerHTML/.test(text)) {
        findings.push({ severity: "CRITICAL", summary: `unsafe dynamic code execution (${currentPath}:${lineNo})`, path: currentPath, line: lineNo, side: "RIGHT" });
      }
    }
  }
  return findings;
}
