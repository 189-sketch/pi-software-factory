/**
 * Real LLM adapter built on @mariozechner/pi-ai + @mariozechner/pi-agent-core.
 *
 * Reads:
 *   ANTHROPIC_BASE_URL   (required; may be supplied by daemon env fallback)
 *   ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY
 *   ANTHROPIC_MODEL      (required; ANTHROPIC_DEFAULT_HAIKU_MODEL is also accepted)
 *
 * Exposes:
 *   isLlmConfigured()      - true when an API key is present
 *   createLlmAgent(opts)   - returns an Agent from pi-agent-core bound to our tools
 *   runLlmLoop(...)        - runs a single prompt and returns the final assistant text
 */
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import {
  getModels,
  streamSimple,
  type AssistantMessage,
  type Model,
  type TextContent,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { AgentContext } from "./types.js";

export function isLlmConfigured(): boolean {
  return Boolean(getApiKey() && getBaseUrl() && getModelId());
}

export function getApiKey(): string | undefined {
  return process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || undefined;
}

export function getModelId(): string | undefined {
  return process.env.ANTHROPIC_MODEL || process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || undefined;
}

export function getBaseUrl(): string | undefined {
  return process.env.ANTHROPIC_BASE_URL || undefined;
}

export function getLlmRequestOptions(): { timeoutMs?: number; maxRetries?: number; maxTokens?: number } {
  return {
    timeoutMs: positiveInteger(process.env.FACTORY_LLM_TIMEOUT_MS ?? process.env.API_TIMEOUT_MS),
    maxRetries: nonNegativeInteger(process.env.ANTHROPIC_MAX_RETRIES),
    maxTokens: positiveInteger(process.env.ANTHROPIC_MAX_TOKENS),
  };
}

/**
 * Construct an Anthropic-compatible Model pointing at the configured base URL.
 * We use a registered Anthropic model only as the SDK capability schema, then
 * replace the request model id and base URL with environment values.
 */
export function buildAnthropicModel(modelId?: string): Model<"anthropic-messages"> {
  const resolvedModelId = modelId || getModelId();
  const baseUrl = getBaseUrl();
  if (!baseUrl || !resolvedModelId) {
    throw new Error("LLM configuration requires ANTHROPIC_BASE_URL and ANTHROPIC_MODEL (or ANTHROPIC_DEFAULT_HAIKU_MODEL)");
  }
  const base = getModels("anthropic").find((candidate) => candidate.api === "anthropic-messages");
  if (!base) throw new Error("pi-ai has no Anthropic capability schema registered");
  const requestOptions = getLlmRequestOptions();
  return {
    ...base,
    id: resolvedModelId,
    name: resolvedModelId,
    baseUrl,
    maxTokens: requestOptions.maxTokens ?? base.maxTokens,
    headers: {
      "x-api-key": getApiKey() ?? "",
      "anthropic-version": "2023-06-01",
    },
  };
}

export const streamWithLlmOptions: typeof streamSimple = (model, context, options = {}) => {
  const configured = getLlmRequestOptions();
  return streamSimple(model, context, {
    ...options,
    ...(configured.timeoutMs === undefined ? {} : { timeoutMs: configured.timeoutMs }),
    ...(configured.maxRetries === undefined ? {} : { maxRetries: configured.maxRetries }),
    ...(configured.maxTokens === undefined ? {} : { maxTokens: configured.maxTokens }),
  });
};

/**
 * Convert our internal AgentTool shape (record args) to pi-agent-core's AgentTool
 * shape (typed Static<TParameters> params). For simplicity we use a permissive
 * schema and let the LLM pass arbitrary JSON; the tool wrapper does runtime
 * validation.
 */
export function toAgentTools(
  tools: Array<{ name: string; description: string; execute: (args: Record<string, unknown>, ctx: AgentContext) => Promise<unknown> }>,
  ctx: AgentContext,
): AgentTool[] {
  return tools.map((t) => ({
    name: t.name,
    label: t.name,
    description: t.description,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: true,
    } as any,
    execute: async (_id, params) => {
      const result = await t.execute(params as Record<string, unknown>, ctx);
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return {
        content: [{ type: "text", text } as TextContent],
        details: result,
      };
    },
  }));
}

export interface LlmRunResult {
  text: string;
  messages: unknown[];
  stopReason: string;
}

/**
 * Run a single prompt against the configured LLM with the given tools.
 * Returns the final assistant text and the full transcript.
 */
export async function runLlmLoop(opts: {
  systemPrompt: string;
  userPrompt: string;
  tools: AgentTool[];
  maxSteps?: number;
}): Promise<LlmRunResult> {
  if (!isLlmConfigured()) {
    throw new Error("LLM not configured: set ANTHROPIC_AUTH_TOKEN (or ANTHROPIC_API_KEY) and ANTHROPIC_BASE_URL");
  }
  const agent = new Agent({
    getApiKey: async () => getApiKey() ?? undefined,
    streamFn: streamWithLlmOptions,
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: buildAnthropicModel(),
      tools: opts.tools,
    },
  });
  await agent.prompt(opts.userPrompt);
  await agent.waitForIdle();

  // Pull the final assistant message.
  const messages = (agent.state.messages as unknown[]) ?? [];
  let finalText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; content?: unknown; stopReason?: string };
    if (m.role === "assistant") {
      const content = m.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          const p = part as { type?: string; text?: string };
          if (p.type === "text" && typeof p.text === "string") finalText += p.text;
        }
      } else if (typeof content === "string") {
        finalText = content;
      }
      break;
    }
  }
  return { text: finalText, messages, stopReason: "end_turn" };
}

function positiveInteger(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}
