import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));

async function run(t, args) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "factory cli options "));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "bin"));
  await fs.mkdir(path.join(dir, "scripts"));
  await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  await fs.copyFile(path.join(root, "bin/factory.js"), path.join(dir, "bin/factory.js"));
  for (const file of ["scripts/factory-daemon.mjs", "scripts/install-factory.mjs", "bin/factory-panel.js"]) {
    await fs.writeFile(path.join(dir, file), 'console.log(JSON.stringify(process.argv.slice(2)));');
  }
  const { stdout } = await exec(process.execPath, ["--", path.join(dir, "bin/factory.js"), ...args], { cwd: dir, timeout: 5000 });
  return JSON.parse(stdout.trim());
}

test("factory start forwards documented kebab-case values and safety flags", async (t) => {
  const options = ["--repo", "owner/repo", "--interval", "2", "--local-dir", "in box", "--webhook-port", "8081", "--env-file", "my.env", "--state-dir", "state", "--workdir", "work", "--once", "--no-env-file", "--no-fallback-env"];
  assert.deepEqual(await run(t, ["start", ...options]), options);
});

test("factory start forwards the daily stage", async (t) => {
  assert.deepEqual(await run(t, ["start", "--daily"]), ["--daily"]);
});

test("factory install supports non-interactive and service options", async (t) => {
  assert.deepEqual(await run(t, ["install", "target", "--mode", "local", "--repo", "owner/repo", "--non-interactive", "--install-service"]), ["target", "--mode", "local", "--repo", "owner/repo", "--non-interactive", "--install-service"]);
});

test("factory panel forwards port, host, and target", async (t) => {
  const options = ["--port", "5199", "--host", "127.0.0.1", "--target", "my target"];
  assert.deepEqual(await run(t, ["panel", ...options]), options);
});
