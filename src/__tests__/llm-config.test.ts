import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAnthropicModel,
  getBaseUrl,
  getLlmRequestOptions,
  getModelId,
  isLlmConfigured,
} from "../core/llm.js";

test("LLM adapter has no hard-coded base URL or model fallback", () => {
  const previous = { ...process.env };
  try {
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;

    assert.equal(getBaseUrl(), undefined);
    assert.equal(getModelId(), undefined);
    assert.equal(isLlmConfigured(), false);
    assert.throws(() => buildAnthropicModel(), /ANTHROPIC_BASE_URL/);
  } finally {
    process.env = previous;
  }
});

test("LLM adapter applies model, base URL, token budget, timeout, and retries from environment", () => {
  const previous = { ...process.env };
  try {
    process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:15721";
    process.env.ANTHROPIC_MODEL = "test-model";
    process.env.ANTHROPIC_MAX_TOKENS = "12345";
    process.env.API_TIMEOUT_MS = "456789";
    process.env.ANTHROPIC_MAX_RETRIES = "4";

    const model = buildAnthropicModel();
    const options = getLlmRequestOptions();

    assert.equal(model.id, "test-model");
    assert.equal(model.baseUrl, "http://127.0.0.1:15721");
    assert.equal(model.maxTokens, 12345);
    assert.deepEqual(options, { timeoutMs: 456789, maxRetries: 4, maxTokens: 12345 });
  } finally {
    process.env = previous;
  }
});
