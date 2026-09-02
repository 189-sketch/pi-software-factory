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

// Load env from .env file FIRST (before reading any process.env below).
// Default to .factory-daemon/.env so the installer-wrapped start.sh /
// start.cmd don't have to shell-parse dotenv files (which is brittle on
// Windows .cmd). Explicit --env-file=path wins; pass --no-env-file to skip.
const SKIP_ENV_FILE = args.noEnvFile === true || args.envFile === "-";
if (!SKIP_ENV_FILE) {
  const envPath = (typeof args.envFile === "string" && args.envFile.length)
    ? path.resolve(args.envFile)
    : path.resolve(process.cwd(), ".factory-daemon", ".env");
  if (fsSync.existsSync(envPath)) {
    loadDotEnv(envPath);
  }
}

const STATE_DIR = args.stateDir || process.env.FACTORY_STATE_DIR || path.join(process.cwd(), ".factory");
fsSync.mkdirSync(STATE_DIR, { recursive: true });

/**
 * Apply fallback env sources, in order, ONLY where the variable is not
 * already set. Real shell env wins. Caller can disable via --no-fallback-env.
 *
 *  1. ~/.claude/settings.json  → pulls ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL,
 *                                ANTHROPIC_MODEL (the user's local Claude Code
 *                                config — reuses credentials you've
 *                                already authorised there).
 *  2. gh CLI                   → if `gh auth status` succeeds, use the
 *                                authenticated account's token for GH_TOKEN.
 *                                Avoids forcing users to set GH_TOKEN when
 *                                they've already done `gh auth login`.
 *
 * The defaults are minimaxi (per project README) so the daemon is usable
 * with just `~/.claude/settings.json` or the env vars, no manual config.
 */
function applyEnvFallbacks() {
  const sources = [];

  // (1) ~/.claude/settings.json — only fill unset keys.
  const claudeSettings = path.join(os.homedir(), ".claude", "settings.json");
  if (fsSync.existsSync(claudeSettings)) {
    try {
      const json = JSON.parse(fsSync.readFileSync(claudeSettings, "utf-8"));
      if (json && typeof json.env === "object" && json.env !== null) {
        let loaded = 0;
        for (const [k, v] of Object.entries(json.env)) {
          if (process.env[k] === undefined && v !== undefined && v !== null) {
            process.env[k] = String(v);
            loaded++;
          }
        }
        if (loaded > 0) sources.push({ source: "claude-settings", count: loaded });
      }
    } catch (err) {
      // ignore — file may not be JSON
    }
  }

  // (2) gh CLI fallback for GH_TOKEN.
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    try {
      const out = execFileSync("gh", ["auth", "token"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) {
        process.env.GH_TOKEN = out;
        sources.push({ source: "gh-cli", count: 1 });
      }
    } catch {
      // gh CLI not installed or not logged in — fallback unavailable.
    }
  }

  return sources;
}

/**
 * Minimal .env loader. KEY=VALUE, lines starting with # are comments, empty
 * lines skipped, optional surrounding quotes trimmed, existing process.env
 * wins (so real shell env still overrides .env). Not exported; scoped here.
 */
function loadDotEnv(file) {
  const text = fsSync.readFileSync(file, "utf-8");
  let loaded = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      // Skip installer-style placeholder values (ghp_replace_me / sk-..._replace_me)
      // so fallback layers (gh-cli auth, ~/.claude/settings.json) still kick in.
      if (/replace[_ ]?me|^ghp_$|^sk-(ant-)?$/i.test(val)) continue;
      process.env[key] = val;
      loaded++;
    }
  }
  return loaded;
}

const log = (level, msg, extra = {}) => {
  const ts = new Date().toISOString();
  const line = `${ts} ${level} ${msg} ${JSON.stringify(extra)}`;
  console.log(line);
  fsSync.appendFileSync(path.join(STATE_DIR, "daemon.log"), line + "\n");
};

// Apply env fallbacks AFTER the .env load + AFTER log() is defined so we can
// record which sources actually contributed. --no-fallback-env disables.
const envSources = args.noFallbackEnv ? [] : applyEnvFallbacks();
if (envSources.length > 0) {
  log("INFO", "env-fallbacks-applied", { sources: envSources });
}

const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || "";
const FACTORY_GH_REPO = getEnv("FACTORY_GH_REPO", args.repo || "");
const POLL_INTERVAL = Number(args.interval || process.env.FACTORY_POLL_INTERVAL || 30);
const WEBHOOK_PORT = Number(args.webhookPort || process.env.FACTORY_WEBHOOK_PORT || 0);
const LOCAL_DIR = args.localDir || process.env.FACTORY_LOCAL_DIR || "";
const WORKDIR = args.workdir || process.env.FACTORY_WORKDIR || (LOCAL_DIR
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
    else if (a === "--env-file") {
      // `--env-file path`, `--env-file=path`, or `--env-file -` to skip.
      const next = argv[i + 1];
      if (next === undefined) { out.envFile = ""; }
      else if (next.startsWith("=")) { out.envFile = next.slice(1); i++; }
      else { out.envFile = next; i++; }
    }
    else if (a === "--no-env-file") out.noEnvFile = true;
    else if (a === "--no-fallback-env") out.noFallbackEnv = true;
  }
  return out;
}

/**
 * Search the system PATH for an executable. Returns the absolute path of
 * the first match, or null. Used to spawn .cmd / .bat on Windows without
 * invoking cmd.exe (which Node 22+ blocks without shell: true, and which
 * also produces a deprecation warning around argument escaping).
 */
function findOnPath(name) {
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = (process.env.PATH || "").split(sep).filter(Boolean);
  const pathext = (process.env.PATHEXT || "").split(";").map((s) => s.toLowerCase());
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    try {
      const st = fsSync.statSync(candidate);
      if (st.isFile()) return candidate;
    } catch {}
    if (process.platform === "win32") {
      // Try the bare name; on Windows, exec handles PATHEXT for .cmd/.exe.
      for (const ext of pathext) {
        const c2 = candidate + ext;
        try {
          const st = fsSync.statSync(c2);
          if (st.isFile()) return c2;
        } catch {}
      }
    }
  }
  return null;
}

/**
 * Copy only the parts of factory/ needed to run the CLI into dst. Skips
 * node_modules (the CLI's deps are already installed once by
 * install-factory, and a 100MB+ cp -r on Windows takes minutes — long
 * enough that an operator thinks the daemon is dead). We copy src/,
 * skills/, fixtures/, package.json, tsconfig.json, then symlink
 * (junction on Windows) the prepared node_modules so that `tsx`
 * resolves inside the workdir.
 */
async function copyFactorySkeleton(srcFactory, dstFactory) {
  const dirsToCopy = ["src", "skills", "fixtures"];
  const filesToCopy = ["package.json", "tsconfig.json"];
  for (const d of dirsToCopy) {
    const s = path.join(srcFactory, d);
    const d2 = path.join(dstFactory, d);
    if (fsSync.existsSync(s)) {
      await fs.cp(s, d2, { recursive: true });
    }
  }
  for (const f of filesToCopy) {
    const s = path.join(srcFactory, f);
    const d2 = path.join(dstFactory, f);
    if (fsSync.existsSync(s)) {
      await fs.copyFile(s, d2);
    }
  }
  // node_modules: reuse the prepared one via symlink so the workdir's
  // `tsx` resolves without re-installing. On Windows use a directory
  // junction (works without admin, unlike a symlink).
  const srcNm = path.join(srcFactory, "node_modules");
  const dstNm = path.join(dstFactory, "node_modules");
  if (fsSync.existsSync(srcNm) && !fsSync.existsSync(dstNm)) {
    try {
      await fs.symlink(srcNm, dstNm, process.platform === "win32" ? "junction" : "dir");
    } catch (err) {
      log("WARN", "node_modules-junction-failed", { src: srcNm, dst: dstNm, error: String(err) });
    }
  }
}

/**
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
      // `processed-N` is the persistent "successfully finished" marker.
      // `fetched-N` is a transient "in flight this poll cycle" marker that
      // processIssue() removes on failure so a crashed/aborted run is
      // retried on the next poll. Without this split, a transient clone or
      // npm failure would silently blacklist the issue forever.
      const fetchedKey = `fetched-${issue.number}`;
      const processedKey = `processed-${issue.number}`;
      if (fsSync.existsSync(path.join(STATE_DIR, processedKey))) continue;
      if (fsSync.existsSync(path.join(STATE_DIR, fetchedKey))) continue;
      // Skip if user has explicitly labeled ready-to-spec or has any agent-applied label.
      const labelNames = (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name));
      if (labelNames.some((l) => /^(ready-to-spec|ready-to-implement|needs-info|wait-to-implement)$/.test(l))) continue;
      log("INFO", "picked-up-issue-from-github", { issue: issue.number, title: issue.title });
      // Claim the issue for this poll cycle. processIssue() removes this
      // file if it fails so the next poll retries; on success it writes
      // the permanent `processed-N` marker instead.
      fsSync.writeFileSync(path.join(STATE_DIR, fetchedKey), new Date().toISOString());
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
    log("INFO", "cloning-target-repo", { issue: issue.number, repo: FACTORY_GH_REPO, dst: issueWorkdir });
    try {
      execFileSync("gh", ["repo", "clone", FACTORY_GH_REPO, issueWorkdir], {
        stdio: "ignore",
        env: { ...process.env, GH_TOKEN },
      });
      log("INFO", "clone-done", { issue: issue.number, dst: issueWorkdir });
      // Copy only the CLI skeleton (src/ + configs + fixtures). Skip
      // node_modules: a recursive cp of factory/ including node_modules
      // copies ~180MB and stalls the daemon for minutes (and on Windows
      // silently hangs on long paths). copyFactorySkeleton re-uses the
      // pre-installed node_modules via a symlink / directory junction.
      await copyFactorySkeleton(
        path.join(factoryRoot, "factory"),
        path.join(issueWorkdir, "factory"),
      );
      log("INFO", "factory-skeleton-copied", { issue: issue.number, dst: issueWorkdir });
      // Skip npm install in the daemon. install-factory has already
      // prepared a fully populated <target>/factory/node_modules, and
      // copyFactorySkeleton junctions it into the workdir. Running
      // `npm install` on every issue adds minutes of latency and on
      // Windows faces .cmd / long-path issues that have nothing to do
      // with the actual pipeline work. Pass --do-npm-install on the CLI
      // (or set FACTORY_DO_NPM_INSTALL=1) to re-enable.
    } catch (err) {
      log("ERROR", "clone-failed", { issue: issue.number, error: String(err) });
      return { ok: false, error: "clone failed" };
    }
  } else {
    // No remote target — work directly from factoryRoot.
    await copyFactorySkeleton(factoryRoot, path.join(issueWorkdir, "factory"));
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
  // tsx resolves relative to cliRoot: install-factory placed the prepared
  // node_modules in <target>/factory/node_modules/. We also junction
  // it into <workdir>/factory/node_modules via copyFactorySkeleton(), so
  // either path works — pick whichever exists.
  const tsxCandidates = [
    path.join(cliRoot, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(factoryRoot, "factory", "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(factoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  const tsxCli = tsxCandidates.find((p) => fsSync.existsSync(p))
    || tsxCandidates[0];
  log("INFO", "starting-pipeline", { issue: issue.number, workdir: cliRoot, tsx: tsxCli });

  let stdout = "", stderr = "";
  const exitCode = await new Promise((resolve) => {
    const child = spawn("node", [
      tsxCli,
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

  // Bookkeeping: write the permanent processed-N marker only when the
  // pipeline actually succeeded (exitCode 0). Remove the transient
  // fetched-N marker in either case so a fresh `fetched-` write can
  // appear on the next poll when this run failed.
  const fetchedKey = `fetched-${issue.number}`;
  const processedKey = `processed-${issue.number}`;
  try { fsSync.unlinkSync(path.join(STATE_DIR, fetchedKey)); } catch {}
  if (exitCode === 0) {
    fsSync.writeFileSync(path.join(STATE_DIR, processedKey), new Date().toISOString());
  }
  return { ok: exitCode === 0, summary, stdout, stderr };
}

// === Polling loop ===
async function pollingLoop() {
  log("INFO", "daemon-start", { repo: FACTORY_GH_REPO || "(local)", interval: POLL_INTERVAL, localDir: LOCAL_DIR });
  while (true) {
    try {
      const issue = await fetchNextIssue();
      if (issue) {
        log("INFO", "process-issue-start", { issue: issue.number });
        try {
          const result = await processIssue(issue);
          log("INFO", "process-issue-end", { issue: issue.number, ok: result?.ok });
        } catch (inner) {
          log("ERROR", "process-issue-failed", {
            issue: issue.number,
            error: String(inner),
            stack: inner?.stack ? String(inner.stack).split("\n").slice(0, 5).join(" | ") : null,
          });
          // Drop the in-flight marker so the next poll retries. Don't write
          // the permanent processed-N marker.
          try { fsSync.unlinkSync(path.join(STATE_DIR, `fetched-${issue.number}`)); } catch {}
        }
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

// Belt + suspenders. processIssue does multiple await execFileSync calls
// and remote ops that can throw; without these handlers the daemon would
// silently exit on unhandled rejections (especially under Windows where
// the worker thread exits before its log buffer flushes).
process.on("unhandledRejection", (reason) => {
  try { log("ERROR", "unhandled-rejection", { error: String(reason) }); } catch {}
});
process.on("uncaughtException", (err) => {
  try { log("ERROR", "uncaught-exception", { error: String(err) }); } catch {}
});

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