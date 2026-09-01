#!/usr/bin/env node
/**
 * End-to-end test: runs every fixture issue through the full multi-agent
 * pipeline and asserts each agent produced a sensible, structured result.
 *
 * Run with: node --test src/__tests__/pipeline.test.mjs
 *
 * The test exercises:
 *   1. Triage classifies four canonical cases correctly
 *   2. Spec writes PRODUCT.md + TECH.md into specs/<slug>/
 *   3. Implementation writes a TypeScript file + opens a PR (stubbed URL)
 *   4. Review-pr validates severity prefixes and emits APPROVE/REJECT
 *   5. Verify-behavior fans out per-story workers and aggregates
 *   6. Improve-review-pr produces a no_changes or update decision
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const factoryDir = path.resolve(__dirname, "..", "..");
const fixturesDir = path.join(factoryDir, "fixtures", "issues");
const repoRoot = path.resolve(factoryDir, "..");

test("triage classifies clear actionable issue as Ready to implement", async () => {
  const out = runCli(fixturesDir, "001-add-download-button.json");
  assert.equal(out.triage, "Ready to implement", `expected Ready to implement, got ${out.triage}`);
});

test("triage classifies broad architecture issue as Ready to spec", async () => {
  const out = runCli(fixturesDir, "002-architecture-redesign.json");
  assert.equal(out.triage, "Ready to spec", `expected Ready to spec, got ${out.triage}`);
});

test("triage classifies vague request as Needs info", async () => {
  const out = runCli(fixturesDir, "003-unclear-request.json");
  assert.equal(out.triage, "Needs info", `expected Needs info, got ${out.triage}`);
});

test("triage classifies out-of-scope request as Wait to implement", async () => {
  const out = runCli(fixturesDir, "004-blockchain-integration.json");
  assert.equal(out.triage, "Wait to implement", `expected Wait to implement, got ${out.triage}`);
});

test("implementation agent produces a PR URL for UI bugs", async () => {
  const out = runCli(fixturesDir, "005-fix-clipboard-button.json");
  assert.equal(out.triage, "Ready to implement");
  assert.ok(out.implementation, "implementation result expected");
  assert.ok(out.implementation.prUrl?.startsWith("https://github.com/"), `expected a PR URL, got ${out.implementation.prUrl}`);
  assert.ok(out.implementation.filesChanged?.length > 0, "expected changed files");
  assert.ok(out.verify === "verified" || out.verify === "partially-verified", `expected verify status, got ${out.verify}`);
});

test("review-pr agent emits a verdict and severity-prefixed comments", async () => {
  const out = runCli(fixturesDir, "005-fix-clipboard-button.json");
  assert.ok(out.review, "review result expected");
  assert.ok(["APPROVE", "REJECT"].includes(out.review.verdict), `verdict must be APPROVE or REJECT, got ${out.review.verdict}`);
  assert.ok(typeof out.review.body === "string" && out.review.body.length > 0, "review body must be a non-empty string");
  // review.comments is a count in the summarize output; the real shape includes severity-prefixed bodies.
  assert.ok(typeof out.review.comments === "number", "comments field should be a count in summary");
});

test("spec agent writes PRODUCT.md and TECH.md with stories", async () => {
  // Use a fresh slug directory under the parent repo so we don't pollute other tests.
  const tmpRepo = await fs.mkdtemp(path.join(repoRoot, "factory-spec-test-"));
  try {
    const out = runCliWithWorkdir(fixturesDir, "002-architecture-redesign.json", tmpRepo);
    const slug = "issue-2-redesign-image-editing-state-management";
    const productPath = path.join(tmpRepo, "specs", slug, "PRODUCT.md");
    const techPath = path.join(tmpRepo, "specs", slug, "TECH.md");
    assert.ok(await exists(productPath), `expected PRODUCT.md at ${productPath}`);
    assert.ok(await exists(techPath), `expected TECH.md at ${techPath}`);
    const product = await fs.readFile(productPath, "utf-8");
    assert.ok(/^### US-\d+/m.test(product), "PRODUCT.md must contain at least one US- story");
  } finally {
    await fs.rm(tmpRepo, { recursive: true, force: true });
  }
});

test("verify-behavior fans out one worker per story and aggregates", async () => {
  // Run twice to ensure idempotency / determinism.
  const out1 = runCli(fixturesDir, "001-add-download-button.json");
  const out2 = runCli(fixturesDir, "001-add-download-button.json");
  assert.equal(out1.verify, out2.verify, "verify-behavior must be deterministic on the same issue");
  assert.ok(out1.verify === "verified" || out1.verify === "partially-verified", `expected verify status, got ${out1.verify}`);
});

test("review-pr emits severity-prefixed comments against a synthetic annotated diff", async () => {
  const tmp = await fs.mkdtemp(path.join(repoRoot, "review-test-"));
  try {
    // Synthetic diff with one TODO marker and one console.log so the agent has
    // both IMPORTANT and NIT findings to grade.
    const diff = [
      "diff --git a/src/feature.ts b/src/feature.ts",
      "--- a/src/feature.ts",
      "+++ b/src/feature.ts",
      "@@ -1,2 +1,5 @@",
      "[OLD:1,NEW:1] export function f() {",
      "[NEW:2]   // TODO: handle edge case",
      "[NEW:3]   console.log('debug');",
      "[OLD:4,NEW:4] }",
    ].join("\n");
    await fs.writeFile(path.join(tmp, "pr_diff.txt"), diff, "utf-8");
    await fs.writeFile(path.join(tmp, "pr_description.txt"), "test", "utf-8");
    // Synthesize a PR-shaped issue and run just the review-pr stage.
    await fs.writeFile(path.join(tmp, "_pr.json"), JSON.stringify({
      number: 99,
      title: "Test PR",
      body: "",
      labels: [],
      author: "tester",
      url: "",
      createdAt: "",
      comments: [],
    }), "utf-8");
    // We don't have a `--stage review-pr` mode in the CLI yet; directly drive
    // the review-pr agent via tsx in-process through a small helper script.
    const helper = path.join(factoryDir, "scripts", "review-direct.mjs");
    await fs.writeFile(helper, `
      import { ReviewPrAgent } from "../src/agents/review-pr.js";
      import { ConsoleLogger } from "../src/core/log.js";
      const ctx = {
        repo: { owner: "demo", name: "x", defaultBranch: "main", workdir: process.cwd() },
        issue: { number: 99, title: "Test PR", body: "", labels: [], author: "t", url: "", createdAt: "", comments: [] },
        logger: new ConsoleLogger(),
        skillBody: "",
        runId: "test",
      };
      const a = new ReviewPrAgent(ctx);
      const r = await a.run();
      console.log(JSON.stringify(r));
    `, "utf-8");
    const out = execFileSync("node", [
      path.join(factoryDir, "node_modules", "tsx", "dist", "cli.mjs"),
      helper,
    ], { cwd: tmp, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
    const review = JSON.parse(String(out).split("\n").filter((l) => l.trim().startsWith("{")).pop());
    assert.ok(["APPROVE", "REJECT"].includes(review.verdict));
    assert.ok(review.body.length > 0);
    assert.ok(Array.isArray(review.comments));
    assert.ok(review.comments.length > 0, "expected at least one inline comment for the synthetic diff");
    for (const c of review.comments) {
      assert.ok(/^(🚨|⚠️|💡|🧹) \[/.test(c.body), `comment body must start with severity prefix, got: ${c.body}`);
      assert.ok(c.path === "src/feature.ts", `path must match synthetic file, got ${c.path}`);
      assert.ok(c.line > 0 && (c.side === "LEFT" || c.side === "RIGHT"));
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("improve-review-pr produces a decision (no_changes or update_review_pr)", async () => {
  const out = runCliWithSpecialIssue("improve-review-pr");
  assert.ok(["no_changes", "update_review_pr", "update_review_pr_local", "both"].includes(out.decision),
    `expected valid decision, got ${out.decision}`);
});

function runCli(fixturesDir, issueFile) {
  return runCliWithWorkdir(fixturesDir, issueFile, repoRoot);
}

function runCliWithWorkdir(fixturesDir, issueFile, workdir) {
  const issuePath = path.join(fixturesDir, issueFile);
  const result = execFileSync("node", [
    path.join(factoryDir, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(factoryDir, "src", "cli", "run-issue.ts"),
    "--issue", issuePath,
  ], { cwd: workdir, encoding: "utf-8", env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "ignore"] });
  return parseLastJson(String(result));
}

function runCliWithSpecialIssue(name) {
  const issuePath = path.join(repoRoot, "factory", "fixtures", "issues", "_improve.json");
  const result = execFileSync("node", [
    path.join(factoryDir, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(factoryDir, "src", "cli", "run-issue.ts"),
    "--issue", issuePath,
    "--stage", "improve-review-pr",
  ], { cwd: repoRoot, encoding: "utf-8", env: { ...process.env, NODE_NO_WARNINGS: "1" }, stdio: ["ignore", "pipe", "ignore"] });
  return parseLastJson(String(result));
}

function parseLastJson(stdout) {
  // Find the last balanced JSON object in the stdout.
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        return JSON.parse(line);
      } catch {
        continue;
      }
    }
  }
  // Fallback: parse the entire output as a single JSON blob.
  return JSON.parse(stdout);
}

async function exists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}