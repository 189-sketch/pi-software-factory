import test from "node:test";
import assert from "node:assert/strict";
import {
    getBaseUrl,
    getLlmRequestOptions,
    getModelId,
    isLlmConfigured,
    getModelAdapter,
    listAdapterKeys,
} from "../core/model-adapter.js";

test("LLM adapter has no hard-coded base URL or model fallback", async () => {
    const previous = { ...process.env };
    try {
        delete process.env.ANTHROPIC_AUTH_TOKEN;
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.ANTHROPIC_MODEL;
        delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
        delete process.env.FACTORY_MODEL_NAME;

        assert.equal(getBaseUrl(), undefined);
        assert.equal(getModelId(), undefined);
        assert.equal(isLlmConfigured(), false);
        // No default adapter is registered for the empty case — but
        // resolveAdapter() always returns the registered "default" which
        // is the Anthropic adapter, and it rejects buildModel when
        // config is missing.
        await assert.rejects(() => getModelAdapter().buildModel(), /ANTHROPIC_BASE_URL/);
    } finally {
        process.env = previous;
    }
});

test("LLM adapter applies model, base URL, token budget, timeout, and retries from environment", async () => {
    const previous = { ...process.env };
    try {
        process.env.ANTHROPIC_AUTH_TOKEN = "test-token";
        process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:15721";
        process.env.ANTHROPIC_MODEL = "test-model";
        process.env.ANTHROPIC_MAX_TOKENS = "12345";
        process.env.API_TIMEOUT_MS = "456789";
        process.env.ANTHROPIC_MAX_RETRIES = "4";

        const adapter = getModelAdapter();
        assert.equal(adapter.name, "anthropic");
        const model = await adapter.buildModel();
        const options = getLlmRequestOptions();

        assert.equal(model.id, "test-model");
        assert.equal(model.baseUrl, "http://127.0.0.1:15721");
        assert.equal(model.maxTokens, 12345);
        assert.deepEqual(options, {
            timeoutMs: 456789,
            maxRetries: 4,
            maxTokens: 12345,
        });
    } finally {
        process.env = previous;
    }
});

test("built-in adapters include anthropic, echo, and default", () => {
    const keys = listAdapterKeys();
    assert.ok(keys.includes("anthropic"), `missing anthropic adapter: ${keys.join(", ")}`);
    assert.ok(keys.includes("echo"), `missing echo adapter: ${keys.join(", ")}`);
    assert.ok(keys.includes("default"), `missing default adapter: ${keys.join(", ")}`);
});