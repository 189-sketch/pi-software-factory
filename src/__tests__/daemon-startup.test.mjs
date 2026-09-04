import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const factoryRoot = fileURLToPath(new URL("../../", import.meta.url));

// Exercise the real daemon, real tsx and real child processes, without GitHub
// credentials, user dotenv/settings fallbacks, or an LLM call.
async function runDaemon(t, { bundle = false, daily = false, fail = false, realCli = false, relative = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory daemon startup "));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "scripts"));
  await fs.copyFile(path.join(factoryRoot, "scripts/factory-daemon.mjs"), path.join(root, "scripts/factory-daemon.mjs"));
  await fs.writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await fs.symlink(path.join(factoryRoot, "node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");

  const entry = bundle ? "dist/factory/run-issue.js" : "src/cli/run-issue.ts";
  if (realCli) {
    for (const dir of ["src", "skills", "fixtures", "scripts"]) {
      await fs.cp(path.join(factoryRoot, dir), path.join(root, dir), { recursive: true });
    }
    await fs.copyFile(path.join(factoryRoot, "tsconfig.json"), path.join(root, "tsconfig.json"));
  } else {
    await fs.mkdir(path.dirname(path.join(root, entry)), { recursive: true });
    await fs.writeFile(path.join(root, entry), `
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const issue = JSON.parse(readFileSync(args[args.indexOf("--issue") + 1], "utf8"));
const stage = args.includes("--stage") ? args[args.indexOf("--stage") + 1] : "";
if (${fail}) {
  process.stderr.write("diagnostic failure: " + "x".repeat(20000) + " END-OF-ERROR");
  process.exitCode = 7;
} else {
  console.log(JSON.stringify({ issue: issue.number, stage, merged: false }));
}
`);
  }

  const inbox = path.join(root, "inbox");
  const stateDir = path.join(root, "state");
  await fs.mkdir(inbox);
  await fs.writeFile(path.join(inbox, "14.json"), JSON.stringify({ number: 14, title: "new game", body: "" }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(FACTORY_|ANTHROPIC_|GH_|GITHUB_|NODE_OPTIONS$)/i.test(key)) delete env[key];
  }
  env.FACTORY_AGENT_MODE = "stub";
  let result;
  try {
    result = await exec(process.execPath, [
      path.join(root, "scripts/factory-daemon.mjs"),
      "--no-env-file", "--no-fallback-env", "--local-dir", inbox,
      "--state-dir", relative ? "state" : stateDir, "--workdir", relative ? "work" : path.join(root, "work"),
      daily ? "--daily" : "--once",
    ], { cwd: root, env, timeout: 30000, maxBuffer: 1024 * 1024 });
    result.code = 0;
  } catch (error) {
    result = error;
  }
  const state = JSON.parse(await fs.readFile(path.join(stateDir, daily ? "state-improve-review-pr.json" : "state-14.json"), "utf8"));
  return { result, state, stateDir };
}

test("daemon passes the TypeScript entry before --issue through real tsx", async (t) => {
  const { result, state } = await runDaemon(t);
  assert.equal(state.exitCode, 0, state.stderr);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(state.summary.issue, 14);
  assert.match(result.stdout, /"runner":"tsx"/);
});

test("daemon passes --stage to the TypeScript entry", async (t) => {
  const { result, state } = await runDaemon(t, { daily: true });
  assert.equal(state.exitCode, 0, state.stderr);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(state.summary.stage, "improve-review-pr");
});

test("daemon resolves relative state and work directories before spawning", async (t) => {
  const { result, state } = await runDaemon(t, { relative: true });
  assert.equal(state.exitCode, 0, state.stderr);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(state.summary.issue, 14);
});

test("daemon keeps the direct JavaScript bundle argument layout", async (t) => {
  const { result, state } = await runDaemon(t, { bundle: true });
  assert.equal(state.exitCode, 0, state.stderr);
  assert.equal(state.summary.issue, 14);
  assert.match(result.stdout, /"runner":"bundle"/);
});

test("daemon records complete failure output and surfaces stderr in error logs", async (t) => {
  const { result, state, stateDir } = await runDaemon(t, { fail: true });
  assert.equal(state.exitCode, 7, state.stderr);
  assert.equal(result.code, 1);
  assert.ok(state.stderr.endsWith("END-OF-ERROR"));
  assert.ok(state.stderr.length <= 16000);
  assert.match(result.stdout, /ERROR pipeline-failed/);
  assert.match(result.stdout, /END-OF-ERROR/);
  assert.match(result.stdout, /ERROR process-issue-end/);
  await assert.rejects(fs.access(path.join(stateDir, "processed-14")), { code: "ENOENT" });
});

test("daemon runs the actual CLI daily stage end to end in stub mode", async (t) => {
  const { result, state } = await runDaemon(t, { realCli: true, daily: true });
  assert.equal(state.exitCode, 0, state.stderr);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(state.summary.decision, "no_changes");
  assert.equal(state.summary.prsInspected, 0);
});
