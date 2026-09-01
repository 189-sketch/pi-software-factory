/**
 * Real LLM adapter built on @mariozechner/pi-ai + @mariozechner/pi-agent-core.
 *
 * Reads:
 *   ANTHROPIC_BASE_URL   (defaults to https://api.minimaxi.com/anthropic)
 *   ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY
 *   ANTHROPIC_MODEL      (defaults to MiniMax-M3 or any anthropic claude-* id)
 *
 * Exposes:
 *   isLlmConfigured()      - true when an API key is present
 *   createLlmAgent(opts)   - returns an Agent from pi-agent-core bound to our tools
 *   runLlmLoop(...)        - runs a single prompt and returns the final assistant text
 */
import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import {
  getModel,
  streamSimple,
  type AssistantMessage,
  type Model,
  type TextContent,
  type ToolResultMessage,
} from "@mariozechner/pi-ai";
import type { AgentContext } from "./types.js";

const DEFAULT_BASE_URL = "https://api.minimaxi.com/anthropic";
const DEFAULT_MODEL_ID = "claude-haiku-4-5";

export function isLlmConfigured(): boolean {
  return Boolean(getApiKey() && getModelId());
}

export function getApiKey(): string | undefined {
  return process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || undefined;
}

export function getModelId(): string | undefined {
  return process.env.ANTHROPIC_MODEL || process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || DEFAULT_MODEL_ID;
}

export function getBaseUrl(): string {
  return process.env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL;
}

/**
 * Construct an Anthropic-compatible Model pointing at the configured base URL.
 * We register it with pi-ai's API registry on the fly because MiniMax-M3 isn't a
 * known model id; we substitute it with a haiku id but override the baseUrl and
 * the headers so the proxy routes the request correctly.
 */
export function buildAnthropicModel(modelId: string = getModelId()!): Model<"anthropic-messages"> {
  const base = getModel("anthropic", "claude-haiku-4-5");
  return {
    ...base,
    id: modelId,
    name: modelId,
    baseUrl: getBaseUrl(),
    headers: {
      "x-api-key": getApiKey() ?? "",
      "anthropic-version": "2023-06-01",
    },
  };
}

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
    streamFn: streamSimple,
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