import { randomUUID } from "node:crypto";
import type { AgentContext, AgentLogger } from "./types.js";

/**
 * BaseAgent implements the pi-mono-style agent loop pattern.
 *
 * Each concrete agent (triage, spec, implementation, review-pr, verify-behavior,
 * improve-review-pr) extends this class and overrides `plan()` and `act()`.
 * The framework supplies the tool registry and tool executor; subclasses pick
 * which tools to call. The pattern mirrors pi-mono's agent() function.
 */
export interface AgentTool {
  name: string;
  description: string;
  execute(args: Record<string, unknown>, ctx: AgentContext): Promise<unknown>;
}

export interface AgentRunOptions {
  /** Max iterations before forcing termination. */
  maxIterations?: number;
  /** Optional onIteration callback for observability. */
  onIteration?: (iter: number, thought: AgentThought) => void;
}

export interface AgentThought {
  iteration: number;
  plan: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  observation?: string;
  final?: unknown;
}

export abstract class BaseAgent<TResult> {
  abstract readonly name: string;
  protected readonly tools: Map<string, AgentTool> = new Map();

  constructor(
    protected readonly ctx: AgentContext,
    protected readonly tools_: AgentTool[] = [],
  ) {
    for (const tool of tools_) {
      this.tools.set(tool.name, tool);
    }
  }

  /** Concrete agents describe what they plan to do next given the state so far. */
  protected abstract plan(state: AgentState): Promise<AgentPlan>;

  /** Concrete agents apply the tool observation to advance the state. */
  protected abstract act(plan: AgentPlan, observation: unknown, state: AgentState): Promise<AgentState>;

  /** Concrete agents declare when they are done and return the final result. */
  protected abstract finalize(state: AgentState): Promise<TResult>;

  async run(opts: AgentRunOptions = {}): Promise<TResult> {
    const maxIter = opts.maxIterations ?? 12;
    let state: AgentState = { scratch: {}, history: [] };
    for (let i = 0; i < maxIter; i++) {
      const plan = await this.plan(state);
      state.history.push({ iteration: i, plan });
      if (plan.kind === "finish") {
        const final = await this.finalize(state);
        opts.onIteration?.(i, { iteration: i, plan: plan.description, final });
        return final;
      }
      const tool = this.tools.get(plan.toolName);
      if (!tool) {
        throw new Error(`[${this.name}] unknown tool: ${plan.toolName}`);
      }
      this.ctx.logger.info(`[${this.name}] iter=${i} tool=${plan.toolName}`);
      const observation = await tool.execute(plan.args, this.ctx);
      const observationStr = stringifyObservation(observation);
      state.history.push({ iteration: i, observation: observationStr });
      state = await this.act(plan, observation, state);
      opts.onIteration?.(i, {
        iteration: i,
        plan: plan.description,
        toolName: plan.toolName,
        toolArgs: plan.args,
        observation: observationStr,
      });
    }
    throw new Error(`[${this.name}] exceeded max iterations (${maxIter})`);
  }
}

export interface AgentPlan {
  kind: "tool" | "finish";
  description: string;
  toolName?: string;
  args?: Record<string, unknown>;
}

export interface AgentState {
  scratch: Record<string, unknown>;
  history: Array<{ iteration: number; plan?: AgentPlan; observation?: string }>;
}

export function newRunId(): string {
  return randomUUID();
}

function stringifyObservation(obs: unknown): string {
  if (typeof obs === "string") return obs;
  try {
    return JSON.stringify(obs);
  } catch {
    return String(obs);
  }
}

/** Convenience for tools that simply produce stdout text (e.g. running shell). */
export function stdoutOf(obs: unknown): string {
  if (typeof obs === "string") return obs;
  if (obs && typeof obs === "object" && "stdout" in obs) {
    return String((obs as { stdout: unknown }).stdout ?? "");
  }
  return stringifyObservation(obs);
}

/** Convenience for getting the agent's child logger. */
export function agentLogger(parent: AgentLogger, agentName: string, extra: Record<string, unknown> = {}): AgentLogger {
  return parent.child({ agent: agentName, ...extra });
}