/**
 * LlmAgent: an LLM-backed implementation of the agent loop using
 * @mariozechner/pi-agent-core. Each concrete agent can run in either mode:
 *
 *   - "stub": deterministic rule-based (the default; used by tests).
 *   - "llm":  real LLM via pi-agent-core, reading ANTHROPIC_* env vars.
 *
 * The two modes produce the same structured result; tests don't care which.
 */
import { Agent } from "@mariozechner/pi-agent-core";
import { streamSimple, type Model } from "@mariozechner/pi-ai";
import { toAgentTools, isLlmConfigured, buildAnthropicModel } from "./llm.js";
import type { AgentContext } from "./types.js";
import { defaultTools } from "./tools.js";

export type AgentMode = "stub" | "llm";

export interface LlmAgentOpts<TResult> {
  name: string;
  ctx: AgentContext;
  systemPrompt: string;
  userPrompt: string;
  /** Parse the final assistant text into a typed result. */
  parse: (text: string) => TResult;
  /** Tool registry the LLM can call. Defaults to defaultTools(ctx). */
  extraTools?: ReturnType<typeof defaultTools>;
}

/**
 * Run the LLM-backed agent loop and return the parsed result.
 *
 * Throws if `isLlmConfigured()` is false; callers should check first.
 */
export async function runLlmAgent<TResult>(opts: LlmAgentOpts<TResult>): Promise<TResult> {
  if (!isLlmConfigured()) {
    throw new Error("LLM not configured; set ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL");
  }
  const tools = toAgentTools([...(opts.extraTools ?? defaultTools(opts.ctx))], opts.ctx);
  const model: Model<"anthropic-messages"> = buildAnthropicModel();
  const agent = new Agent({
    getApiKey: async () => process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || undefined,
    streamFn: streamSimple,
    initialState: {
      systemPrompt: opts.systemPrompt,
      model,
      tools,
    },
  });
  await agent.prompt(opts.userPrompt);
  await agent.waitForIdle();

  // Find the last assistant text message.
  const messages = (agent.state.messages as unknown[]) ?? [];
  let finalText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown };
    if (m.role === "assistant") {
      if (typeof m.content === "string") {
        finalText = m.content;
        break;
      }
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          const p = part as { type?: string; text?: string };
          if (p.type === "text" && typeof p.text === "string") finalText += p.text;
        }
        if (finalText) break;
      }
    }
  }
  return opts.parse(finalText);
}

/** Returns the agent mode chosen by env vars: `FACTORY_AGENT_MODE=llm` overrides the default. */
export function resolveAgentMode(): AgentMode {
  const explicit = process.env.FACTORY_AGENT_MODE;
  if (explicit === "llm" || explicit === "stub") return explicit;
  return isLlmConfigured() ? "llm" : "stub";
}