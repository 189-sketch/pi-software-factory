#!/usr/bin/env node
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT) || 4011;

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}")));
    });
}

function pickText(system, user) {
    const sys = (system || "").toLowerCase();
    const usr = (user || "").toLowerCase();
    if (sys.includes("triage") || /triage|readiness/i.test(usr)) {
        const isUnclear = /unclear|ambiguous|maybe|kind of|\?$/.test(usr);
        const isOffTopic = /blockchain|nft|off-topic/.test(usr);
        const isArchitect = /architect|redesign|migration|state management|provider/.test(usr);
        if (isUnclear) {
            return JSON.stringify({ state: "Needs info", label: "needs-info", remove_labels: [], comment: "Mock triage: needs info." });
        }
        if (isOffTopic) {
            return JSON.stringify({ state: "Wait to implement", label: "wait-to-implement", remove_labels: [], comment: "Mock triage: off topic." });
        }
        if (isArchitect) {
            return JSON.stringify({ state: "Ready to spec", label: "ready-to-spec", remove_labels: [], comment: "Mock triage: needs spec." });
        }
        return JSON.stringify({
            state: "Ready to implement",
            label: "ready-to-implement",
            remove_labels: ["ready-to-spec", "needs-info", "wait-to-implement", "spec-ready-for-review"],
            comment: "Mock triage: ready to implement.",
        });
    }
    if (sys.includes("implementation") || sys.includes("implement a fix")) {
        return JSON.stringify({
            filesChanged: [],
            testCommand: "node --test src/__tests__/*.test.mjs",
            prUrl: "https://github.com/mock/repo/pull/9001",
            branch: "feature/mock-issue",
        });
    }
    if (sys.includes("review") || sys.includes("annotated diff")) {
        return JSON.stringify({
            verdict: "APPROVE",
            body: "Mock review: no findings.",
            comments: [],
        });
    }
    if (sys.includes("spec") || sys.includes("product.md")) {
        return JSON.stringify({
            product: {
                slug: "mock-issue",
                title: "Mock product spec",
                problem: "Mock problem statement",
                goals: ["ship it"],
                nonGoals: [],
                stories: [],
                acceptanceCriteria: [],
                openQuestions: [],
                body: "# Mock PRODUCT.md",
            },
            tech: {
                slug: "mock-issue",
                approach: "Mock approach",
                affectedAreas: [],
                dataModel: "in-memory",
                apiChanges: [],
                migrationPlan: "none",
                validationPlan: ["node --test"],
                alternatives: [],
                openQuestions: [],
                body: "# Mock TECH.md",
            },
            specBranch: "spec/mock-issue",
            specPrUrl: "https://github.com/mock/repo/pull/9000",
        });
    }
    if (sys.includes("verify") || sys.includes("behavior")) {
        return JSON.stringify({
            mode: "verify",
            status: "verified",
            channel: "browser",
            ozRunUrl: "https://oz.mock/run/1",
            evidence: [],
        });
    }
    if (sys.includes("improve") || sys.includes("review feedback")) {
        return JSON.stringify({
            decision: "no_changes",
            prsInspected: 0,
            feedbackItems: { validated: 0, corrected: 0, refined: 0, ambiguous: 0 },
            learnings: [],
            skillPrUrl: null,
            notes: "Mock improve: nothing to do.",
        });
    }
    return "OK";
}

function buildSse(events) {
    return events.map((e) => "event: " + e.event + "\ndata: " + JSON.stringify(e.data) + "\n\n").join("") + "\n";
}

const server = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url && req.url.endsWith("/v1/models")) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "mock-mini-m3", type: "model", display_name: "Mock" }] }));
        return;
    }
    if (req.method === "POST" && req.url && req.url.endsWith("/v1/messages")) {
        const body = await readBody(req);
        const sys = (body.system || []).map((s) => s.text || "").join("\n");
        const usr = (body.messages || []).map((m) => m.content || "").join("\n");
        const text = pickText(sys, usr);
        const id = "msg_" + Date.now();
        const model = body.model || "mock-mini-m3";
        res.statusCode = 200;
        res.setHeader("content-type", "text/event-stream");
        res.setHeader("cache-control", "no-cache");
        res.setHeader("anthropic-version", "2023-06-01");
        res.write(buildSse([
            { event: "message_start", data: { type: "message_start", message: { id: id, type: "message", role: "assistant", model: model, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } } },
            { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
            { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text } } },
            { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
            { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", usage: { output_tokens: 1 } } } },
            { event: "message_stop", data: { type: "message_stop", "anthropic-type": "message_stop" } },
        ]));
        res.end();
        return;
    }
    res.statusCode = 404;
    res.end("not found");
});

server.listen(PORT, () => {
    process.stdout.write("mock-anthropic listening on http://127.0.0.1:" + PORT + "\n");
});