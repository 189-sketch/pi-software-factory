#!/usr/bin/env node
/**
 * Local factory daemon: polls a target GitHub repo for new issues and
 * processes them on the local machine. Secrets stay local; only finished
 * commits/PRs reach github.com.
 *
 * Usage:
 *   # Option 1: poll a remote GitHub repo
 *   FACTORY_GH_REPO=owner/name \
 *   GH_TOKEN=ghp_... \
 *   ANTHROPIC_AUTH_TOKEN=sk-... \
 *   node scripts/factory-daemon.mjs --interval 60
 *
 *   # Option 2: watch a local directory for issue JSON files (offline / dev)
 *   node scripts/factory-daemon.mjs --local-dir ./issues --interval 5
 *
 *   # Option 3: GitHub webhook (real-time, server required)
 *   node scripts/factory-daemon.mjs --webhook-port 8080
 *
 * Run modes can be combined: --local-dir + --webhook-port, etc.
 *
 * The daemon handles each issue end-to-end (triage → spec → implement →
 * review → verify → push). It writes a JSON record to
 * <workdir>/.factory/state/<n>.json after each run so you can audit.
 */
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const factoryRoot = path.resolve(__dirname, "..");

function getEnv(name, fallback) {
  return process.env[name] || fallback;
}

const args = parseArgs(process.argv.slice(2));
const STATE_DIR = args.stateDir || path.join(process.cwd(), ".factory");
fsSync.mkdirSync(STATE_DIR, { recursive: true });

const log = (level, msg, extra = {}) => {
  const ts = new Date().toISOString();
  const line = `${ts} ${level} ${msg} ${JSON.stringify(extra)}`;
  console.log(line);
  fsSync.appendFileSync(path.join(STATE_DIR, "daemon.log"), line + "\n");
};

const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "";
const FACTORY_GH_REPO = getEnv("FACTORY_GH_REPO", args.repo || "");
const POLL_INTERVAL = Number(args.interval || 30);
const WEBHOOK_PORT = args.webhookPort ? Number(args.webhookPort) : 0;
const LOCAL_DIR = args.localDir || "";
const WORKDIR = args.workdir || (LOCAL_DIR
  ? path.join(process.cwd(), "factory-workdir")
  : path.join(os.tmpdir(), "factory-workdir-" + Date.now()));
const DRY_RUN = args.dry || "";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") out.repo = argv[++i];
    else if (a === "--interval") out.interval = Number(argv[++i]);
    else if (a === "--webhook-port") out.webhookPort = argv[++i];
    else if (a === "--local-dir") out.localDir = argv[++i];
    else if (a === "--workdir") out.workdir = argv[++i];
    else if (a === "--state-dir") out.stateDir = argv[++i];
    else if (a === "--dry-run") out.dry = argv[++i];
  }
  return out;
}

/**
 * Fetch the next new issue from the configured GitHub repo (or local dir).
 * Returns null when there are no new issues.
 */
async function fetchNextIssue() {
  if (LOCAL_DIR) {
    return await fetchNextFromLocalDir();
  }
  if (FACTORY_GH_REPO && GH_TOKEN) {
    return await fetchNextFromGitHub();
  }
  return null;
}

async function fetchNextFromLocalDir() {
  if (!fsSync.existsSync(LOCAL_DIR)) return null;
  const entries = await fs.readdir(LOCAL_DIR);
  entries.sort();
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const filePath = path.join(LOCAL_DIR, name);
    const content = await fs.readFile(filePath, "utf-8");
    try {
      const issue = JSON.parse(content);
      issue._sourceFile = filePath;
      log("INFO", "picked-up-issue-from-local", { issue: issue.number, file: name });
      // Move to .processed so we don't pick it up again.
      await fs.mkdir(path.join(LOCAL_DIR, ".processed"), { recursive: true });
      await fs.rename(filePath, path.join(LOCAL_DIR, ".processed", name));
      return issue;
    } catch (err) {
      log("WARN", "bad-issue-file", { file: name, error: String(err) });
    }
  }
  return null;
}

async function fetchNextFromGitHub() {
  try {
    const out = execFileSync("gh", [
      "issue", "list",
      "--repo", FACTORY_GH_REPO,
      "--state", "open",
      "--json", "number,title,body,labels,author,createdAt,url",
      "--limit", "20",
    ], { encoding: "utf-8", env: { ...process.env, GH_TOKEN } });
    const issues = JSON.parse(out);
    // Sort by createdAt ascending so we process oldest first.
    issues.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    for (const issue of issues) {
      const processedKey = `processed-${issue.number}`;
      if (fsSync.existsSync(path.join(STATE_DIR, processedKey))) continue;
      // Skip if user has explicitly labeled ready-to-spec or has any agent-applied label.
      const labelNames = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
      if (labelNames.some((l) => /^(ready-to-spec|ready-to-implement|needs-info|wait-to-implement)$/.test(l))) continue;
      log("INFO", "picked-up-issue-from-github", { issue: issue.number, title: issue.title });
      // Mark as seen so we don't re-pick within the next poll cycle.
      fsSync.writeFileSync(path.join(STATE_DIR, processedKey), new Date().toISOString());
      // Materialize to a temp issue.json for the CLI.
      const issuePath = path.join(STATE_DIR, `issue-${issue.number}.json`);
      await fs.writeFile(issuePath, JSON.stringify({
        number: issue.number,
        title: issue.title,
        body: issue.body || "",
        labels: labelNames,
        author: issue.author?.login || "unknown",
        url: issue.url,
        createdAt: issue.createdAt,
        comments: [],
      }, null, 2));
      return { ...issue, _issuePath: issuePath };
    }
  } catch (err) {
    log("WARN", "gh-issue-list-failed", { error: String(err) });
  }
  return null;
}

/**
 * Process one issue end-to-end. Sets up a fresh workdir (clone of target
 * repo), invokes the factory CLI, and persists the outcome as state.
 */
async function processIssue(issue) {
  const startedAt = new Date().toISOString();
  const issuePath = issue._issuePath || path.join(STATE_DIR, `issue-${issue.number}.json`);
  // Refresh issue JSON on disk for the CLI.
  await fs.writeFile(issuePath, JSON.stringify({
    number: issue.number,
    title: issue.title,
    body: issue.body || "",
    labels: issue.labels || [],
    author: typeof issue.author === "string" ? issue.author : (issue.author?.login || "unknown"),
    url: issue.url || "",
    createdAt: issue.createdAt || new Date().toISOString(),
    comments: [],
  }, null, 2));

  // Fresh git workdir per issue so concurrent runs don't collide.
  const issueWorkdir = path.join(WORKDIR, `issue-${issue.number}-${Date.now()}`);
  fsSync.mkdirSync(issueWorkdir, { recursive: true });

  if (FACTORY_GH_REPO && GH_TOKEN) {
    // Clone the target repo so commit_and_push has somewhere to push.
    try {
      execFileSync("gh", ["repo", "clone", FACTORY_GH_REPO, issueWorkdir], {
        stdio: "ignore",
        env: { ...process.env, GH_TOKEN },
      });
      // Copy factory/ directory into the workdir so the CLI can run.
      execFileSync("cp", ["-r", path.join(factoryRoot, "factory"), path.join(issueWorkdir, "factory")], { stdio: "ignore" });
      // Install deps (idempotent).
      execFileSync("npm", ["install"], { cwd: path.join(issueWorkdir, "factory"), stdio: "ignore" });
    } catch (err) {
      log("ERROR", "clone-failed", { issue: issue.number, error: String(err) });
      return { ok: false, error: "clone failed" };
    }
  } else {
    // No remote target; just run against a fresh dir.
    execFileSync("cp", ["-r", factoryRoot, issueWorkdir], { stdio: "ignore" });
  }

  const env = {
    ...process.env,
    NODE_TEST: "1", // stub mode by default for the daemon (deterministic)
    FACTORY_REMOTE_PATH: `https://x-access-token:${GH_TOKEN}@github.com/${FACTORY_GH_REPO}.git`,
    FACTORY_GH_REPO,
    GH_TOKEN,
    ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || "https://api.minimaxi.com/anthropic",
    ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL || "MiniMax-M3",
  };

  const cliPath = path.join(issueWorkdir, "factory", "src", "cli", "run-issue.ts");
  const cliRoot = path.join(issueWorkdir, "factory");
  log("INFO", "starting-pipeline", { issue: issue.number, workdir: cliRoot });

  let stdout = "", stderr = "";
  const exitCode = await new Promise((resolve) => {
    const child = spawn("node", [
      path.join(factoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
      cliPath,
      "--issue", issuePath,
    ], { cwd: cliRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (b) => stdout += b);
    child.stderr.on("data", (b) => stderr += b);
    child.on("exit", (code) => resolve(code ?? 0));
  });

  const out = (stdout + "\n" + stderr).trim().split("\n").filter((l) => l.trim().startsWith("{")).pop();
  let summary = {};
  try { summary = JSON.parse(out); } catch {}

  const stateRecord = {
    number: issue.number,
    title: issue.title,
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode,
    workdir: cliRoot,
    summary,
  };
  fsSync.writeFileSync(path.join(STATE_DIR, `state-${issue.number}.json`), JSON.stringify(stateRecord, null, 2));
  log("INFO", "pipeline-done", { issue: issue.number, exitCode, summary });
  return { ok: exitCode === 0, summary, stdout, stderr };
}

// === Polling loop ===
async function pollingLoop() {
  log("INFO", "daemon-start", { repo: FACTORY_GH_REPO || "(local)", interval: POLL_INTERVAL, localDir: LOCAL_DIR });
  while (true) {
    try {
      const issue = await fetchNextIssue();
      if (issue) {
        await processIssue(issue);
      } else {
        await sleep(POLL_INTERVAL * 1000);
      }
    } catch (err) {
      log("ERROR", "loop-error", { error: String(err) });
      await sleep(POLL_INTERVAL * 1000);
    }
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// === Webhook server ===
async function startWebhookServer() {
  if (!WEBHOOK_PORT) return;
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/webhook")) {
      res.writeHead(404); res.end(); return;
    }
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", async () => {
      try {
        const event = req.headers["x-github-event"];
        const payload = JSON.parse(body || "{}");
        if (event === "issues" && payload.action === "opened") {
          log("INFO", "webhook-issue-opened", { number: payload.issue?.number });
          await processIssue({
            number: payload.issue.number,
            title: payload.issue.title,
            body: payload.issue.body || "",
            labels: (payload.issue.labels || []).map((l) => l.name),
            author: payload.issue.user?.login || "unknown",
            url: payload.issue.html_url,
            createdAt: payload.issue.created_at,
          });
        }
        res.writeHead(202, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        log("ERROR", "webhook-error", { error: String(err) });
        res.writeHead(500);
        res.end();
      }
    });
  });
  server.listen(WEBHOOK_PORT, () => {
    log("INFO", "webhook-listening", { port: WEBHOOK_PORT });
  });
}

// === Main ===
(async () => {
  if (!GH_TOKEN) log("WARN", "no-gh-token", {});
  if (!ANTHROPIC_AUTH_TOKEN) log("WARN", "no-anthropic-token", {});
  if (WEBHOOK_PORT) await startWebhookServer();
  await pollingLoop();
})();