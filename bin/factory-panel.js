#!/usr/bin/env node
/**
 * factory-panel — the control-panel HTTP server.
 *
 * Serves the pre-built React dashboard and exposes the same /api/*
 * endpoints the development Vite plugin does, so the panel is functional
 * without going through a JS dev server. Target projects get a working
 * dashboard as soon as they `npm install` this package.
 *
 * Usage:
 *   factory-panel [--port 5174] [--target <path>]
 *
 * If --target is not given, the panel looks at process.cwd()'s
 * .factory-daemon/ for the daemon's poll interval and .factory/ for
 * state files. This matches the layout start.sh drops in.
 */
import http from "node:http";
import { promises as fs, createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port) || 5174;
const HOST = args.host || "127.0.0.1";

// The target repo whose state we visualize. Default: process.cwd().
const targetRoot = path.resolve(args.target || process.cwd());

const DIST_DIR = path.join(packageRoot, "dist", "panel");

function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const eq = a.indexOf("=");
            if (eq >= 0) out[a.slice(2, eq)] = a.slice(eq + 1);
            else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
                out[a.slice(2)] = argv[++i];
            } else {
                out[a.slice(2)] = true;
            }
        } else out._.push(a);
    }
    return out;
}

function mimeOf(p) {
    const ext = path.extname(p).toLowerCase();
    return ({
        ".html": "text/html; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".mjs": "application/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        ".map": "application/json",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
    })[ext] || "application/octet-stream";
}

async function safeRead(p) {
    try { return await fs.readFile(p, "utf-8"); } catch { return null; }
}
async function safeReadJson(p) {
    try { return JSON.parse(await fs.readFile(p, "utf-8")); } catch { return null; }
}
async function listDir(p) {
    try { return await fs.readdir(p); } catch { return []; }
}
async function exists(p) {
    try { await fs.access(p); return true; } catch { return false; }
}

/* -------------------------------------------------------------------------- */
/* API handlers — same surface as control-panel/vite/factoryApi.ts              */
/* -------------------------------------------------------------------------- */

async function readProjects() {
    const out = [];
    const pkg = await safeReadJson(path.join(targetRoot, "package.json"));
    const repoUrl = (() => {
        if (!pkg?.repository) return "owner/name";
        if (typeof pkg.repository === "string") return pkg.repository;
        return pkg.repository.url ?? "owner/name";
    })();
    const dirName = path.basename(targetRoot);
    out.push({
        id: "current",
        name: dirName,
        repo: repoUrl,
        defaultBranch: "main",
        isCurrent: true,
    });
    const envText = await safeRead(path.join(targetRoot, ".factory-daemon", ".env"));
    if (envText) {
        const m = envText.match(/FACTORY_GH_REPO\s*=\s*([^\s#]+)/);
        if (m) {
            const r = m[1].trim();
            out.push({
                id: r.replace(/[^a-z0-9]+/gi, "-").toLowerCase(),
                name: r.split("/")[1] ?? r,
                repo: r,
                defaultBranch: "main",
                isCurrent: false,
            });
        }
    }
    return out;
}

async function computeProjectMetrics() {
    const out = {
        merged7d: 0,
        rejected30d: 0,
        approved30d: 0,
        avgTimeToMergeMs: null,
        started24h: 0,
        closed24h: 0,
    };
    const stateFiles = await listDir(path.join(targetRoot, ".factory", "state"));
    if (stateFiles.length === 0) return out;
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const sevenDayMs = 7 * dayMs;
    const thirtyDayMs = 30 * dayMs;
    const mergeDurations = [];

    for (const f of stateFiles) {
        if (!f.endsWith(".json")) continue;
        const data = await safeReadJson(path.join(targetRoot, ".factory", "state", f));
        if (!data) continue;
        const triageStart = findStageTime(data, "triage", "startedAt");
        const mergeEnd = findStageTime(data, "merge", "endedAt");
        const review = data.review;

        if (mergeEnd) {
            const endMs = Date.parse(mergeEnd);
            if (!Number.isNaN(endMs)) {
                if (now - endMs <= sevenDayMs) out.merged7d++;
                if (triageStart) {
                    const startMs = Date.parse(triageStart);
                    if (!Number.isNaN(startMs) && endMs >= startMs) {
                        mergeDurations.push(endMs - startMs);
                    }
                }
            }
        }
        if (review?.verdict === "REJECT") {
            const endMs = Date.parse(findStageTime(data, "review", "endedAt") ?? "");
            if (!Number.isNaN(endMs) && now - endMs <= thirtyDayMs) out.rejected30d++;
        }
        if (review?.verdict === "APPROVE") {
            const endMs = Date.parse(findStageTime(data, "review", "endedAt") ?? "");
            if (!Number.isNaN(endMs) && now - endMs <= thirtyDayMs) out.approved30d++;
        }
        const stages = ["triage", "spec", "implementation", "review", "verify", "merge"];
        for (const s of stages) {
            const startedAt = findStageTime(data, s, "startedAt");
            const endedAt = findStageTime(data, s, "endedAt");
            if (startedAt) {
                const ms = Date.parse(startedAt);
                if (!Number.isNaN(ms) && now - ms <= dayMs) out.started24h++;
            }
            if (endedAt) {
                const ms = Date.parse(endedAt);
                if (!Number.isNaN(ms) && now - ms <= dayMs) out.closed24h++;
            }
        }
    }

    if (mergeDurations.length > 0) {
        out.avgTimeToMergeMs = Math.round(
            mergeDurations.reduce((a, b) => a + b, 0) / mergeDurations.length,
        );
    }
    return out;
}

function findStageTime(data, stage, key) {
    return data?.[stage]?.[key];
}

async function readIssues() {
    const out = [];
    // Live state files: only real, factory- completed issues count.
    const stateFiles = await listDir(path.join(targetRoot, ".factory", "state"));
    for (const f of stateFiles) {
        if (!f.endsWith(".json")) continue;
        const data = await safeReadJson(path.join(targetRoot, ".factory", "state", f));
        if (data) out.push(data);
    }
    // Discovered issues: GitHub open issues via the gh CLI, if available.
    // The CLI must be authenticated; otherwise the panel stays with state-only.
    const repo = await readCurrentRepo();
    if (repo) {
        try {
            const { stdout } = await execFileP("gh", [
                "issue", "list", "--repo", repo, "--state", "open",
                "--limit", "50",
                "--json", "number,title,body,author,createdAt,url,labels",
            ], { timeout: 4000 });
            for (const raw of JSON.parse(stdout)) {
                out.push({ _discovered: true, issue: raw });
            }
        } catch { /* gh unavailable */ }
    }
    return out;
}

async function readCurrentRepo() {
    const pkg = await safeReadJson(path.join(targetRoot, "package.json"));
    const v = pkg?.repository;
    if (!v) return null;
    if (typeof v === "string") return v;
    return v.url ?? null;
}

async function readEvents() {
    const text = await safeRead(path.join(targetRoot, ".factory", "daemon.log"));
    if (!text) return [];
    const out = [];
    for (const raw of text.split(/\r?\n/)) {
        if (!raw.trim()) continue;
        const m = raw.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
        if (!m) continue;
        const [, ts, level, stage, rest] = m;
        let message = rest, bindings = {};
        const bi = rest.indexOf("{");
        if (bi >= 0) {
            message = rest.slice(0, bi).trim();
            try { bindings = JSON.parse(rest.slice(bi)); } catch {}
        }
        out.push({
            id: `evt-${ts}-${out.length}`,
            ts, level, stage, projectId: "current",
            message, bindings,
        });
    }
    return out.reverse();
}

async function readAgents() {
    // Skills ship pre-built under dist/factory/skills/. They were copied
    // there by the factory build, alongside the orchestrator bundle.
    const out = [];
    const skillsDir = path.join(packageRoot, "dist", "factory", "skills");
    if (!existsSync(skillsDir)) return out;
    const dirs = await listDir(skillsDir);
    for (const f of dirs) {
        if (!f.endsWith(".json")) continue;
        const data = await safeReadJson(path.join(skillsDir, f));
        if (data) out.push(data);
    }
    return out;
}

async function readSettings() {
    let baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.minimaxi.com/anthropic";
    let defaultModel = process.env.ANTHROPIC_MODEL || "MiniMax-M3";
    let pollIntervalSec = 30;
    let daemonActive = false;
    let workdir = targetRoot;

    const envText = await safeRead(path.join(targetRoot, ".factory-daemon", ".env"));
    if (envText) {
        const base = envText.match(/ANTHROPIC_BASE_URL\s*=\s*([^\s#]+)/);
        if (base) baseUrl = base[1].trim();
        const model = envText.match(/ANTHROPIC_MODEL\s*=\s*([^\s#]+)/);
        if (model) defaultModel = model[1].trim();
        const poll = envText.match(/FACTORY_POLL_INTERVAL\s*=\s*(\d+)/);
        if (poll) pollIntervalSec = Number(poll[1]);
    }
    const logPath = path.join(targetRoot, ".factory", "daemon.log");
    if (existsSync(logPath)) {
        try {
            const st = await fs.stat(logPath);
            daemonActive = Date.now() - st.mtimeMs < 5 * 60 * 1000;
        } catch {}
    }
    return {
        baseUrl, defaultModel, pollIntervalSec,
        localDaemon: { active: daemonActive, pid: null, uptimeSec: 0, workdir },
    };
}

/* -------------------------------------------------------------------------- */
/* HTTP server                                                                */
/* -------------------------------------------------------------------------- */

async function serveStatic(req, res, urlPath) {
    let filePath = path.join(DIST_DIR, urlPath === "/" ? "index.html" : urlPath);
    if (!existsSync(filePath)) {
        // SPA fallback: any unknown path returns index.html.
        filePath = path.join(DIST_DIR, "index.html");
    }
    try {
        const stream = createReadStream(filePath);
        res.statusCode = 200;
        res.setHeader("Content-Type", mimeOf(filePath));
        stream.pipe(res);
    } catch {
        res.statusCode = 404;
        res.end("Not found");
    }
}

function send(res, status, body) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", `http://${req.headers.host}`);
    const route = u.pathname;
    try {
        if (req.method === "GET") {
            if (route === "/api/projects") {
                const projects = await readProjects();
                const metrics = {};
                for (const p of projects) metrics[p.id] = await computeProjectMetrics();
                return send(res, 200, { projects, metrics });
            }
            if (route === "/api/events") {
                return send(res, 200, { events: await readEvents() });
            }
            if (route === "/api/agents") {
                return send(res, 200, { agents: await readAgents() });
            }
            if (route === "/api/settings") {
                return send(res, 200, await readSettings());
            }
            const m = route.match(/^\/api\/projects\/([^/]+)(\/issues)?$/);
            if (m) {
                return send(res, 200, {
                    project: (await readProjects()).find((p) => p.id === m[1]) ?? null,
                    issues: await readIssues(),
                });
            }
        }
        // Everything else is a static asset from the built panel.
        return serveStatic(req, res, route);
    } catch (err) {
        send(res, 500, { error: String(err) });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`Control panel ready at http://${ HOST }:${ PORT }`);
    console.log(`Reading factory state from ${ targetRoot }`);
});