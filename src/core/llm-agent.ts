/**
 * LlmAgent: an LLM-backed implementation of the agent loop using
 * @mariozechner/pi-agent-core. Each concrete agent can run in either mode:
 *
 *   - "stub": deterministic rule-based (the default; used by tests).
 *   - "llm":  real LLM via the configured ModelAdapter (default: Anthropic).
 *
 * The two modes produce the same structured result; tests don't care which.
 */
import { Agent } from "@mariozechner/pi-agent-core";
import { type Model } from "@mariozechner/pi-ai";
import { toAgentTools, isLlmConfigured, getModelAdapter } from "./llm.js";
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
    /** Override the adapter. Defaults to FACTORY_MODEL_ADAPTER or "anthropic". */
    adapterName?: string;
}

/**
 * Run the LLM-backed agent loop and return the parsed result.
 *
 * Throws if no adapter is configured; callers should check first.
 */
export async function runLlmAgent<TResult>(opts: LlmAgentOpts<TResult>): Promise<TResult> {
    if (!isLlmConfigured()) {
        throw new Error(
            "LLM not configured: install @mariozechner/pi-ai and set ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL, or supply your own ModelAdapter",
        );
    }
    const tools = toAgentTools([...(opts.extraTools ?? defaultTools(opts.ctx))], opts.ctx);
    const adapter = getModelAdapter();
    const model: Model<string> = adapter.buildModel();
    const agent = new Agent({
        getApiKey: async () => process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || undefined,
        streamFn: adapter.streamFn,
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
        const m = messages[i] as { role?: string; content?: unknown; stopReason?: string; errorMessage?: string };
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
    if (!finalText) {
        const last = messages.at(-1) as { stopReason?: string; errorMessage?: string } | undefined;
        throw new Error([
            `LLM returned no assistant text`,
            `adapter=${adapter.name}`,
            `model=${model.id}`,
            `stopReason=${last?.stopReason ?? "unknown"}`,
            `providerError=${last?.errorMessage ?? agent.state.errorMessage ?? "unknown"}`,
        ].join("; "));
    }
    return opts.parse(finalText);
}

/** Returns the agent mode chosen by env vars: `FACTORY_AGENT_MODE=llm` overrides the default. */
export function resolveAgentMode(): AgentMode {
    const explicit = process.env.FACTORY_AGENT_MODE;
    if (explicit === "llm" || explicit === "stub") return explicit;
    // Default to stub when run under node:test (NODE_TEST=1) so the suite
    // doesn't accidentally hit the LLM and time out.
    if (process.env.NODE_TEST === "1") return "stub";
    return isLlmConfigured() ? "llm" : "stub";
}