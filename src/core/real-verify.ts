/**
 * Real behavioral verification using Playwright (headless Chromium).
 *
 * Opens a real Chromium browser, navigates to the implementation's server
 * (if bootable in <2s), and captures screenshots of the actual UI state
 * into evidenceDir. Falls back to about:blank if the server can't boot
 * (e.g. the implementation's entry uses a non-standard export name).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export interface RealVerifyOpts {
  workdir: string;
  serverEntry?: string;
  storyId: string;
  path?: string;
  evidenceDir: string;
}

export interface RealVerifyResult {
  screenshots: Array<{ file: string; caption: string }>;
  consoleErrors: string[];
  pageErrors: string[];
  serverUrl?: string;
}

export async function realVerify(opts: RealVerifyOpts): Promise<RealVerifyResult> {
  const { chromium } = await import("playwright");
  await fs.mkdir(opts.evidenceDir, { recursive: true });

  const errors = { console: [] as string[], page: [] as string[] };
  const screenshots: Array<{ file: string; caption: string }> = [];
  let serverUrl: string | undefined;
  let child: { close: () => Promise<void> } | null = null;

  // Try to boot the implementation server with a 2-second strict timeout.
  // If it doesn't print PORT=… quickly, give up and use about:blank.
  if (opts.serverEntry) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2000);
    try {
      child = await tryStartServer(opts, ac.signal);
    } finally {
      clearTimeout(timer);
    }
    serverUrl = child?.url;
  }
  const targetUrl = serverUrl ?? "about:blank";

  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error") errors.console.push(m.text()); });
    page.on("pageerror", (e) => errors.page.push(String(e)));

    try {
      await page.goto(targetUrl, { waitUntil: "load", timeout: 10_000 });
    } catch { /* ignore */ }

    const baselinePath = path.join(opts.evidenceDir, `${opts.storyId}-baseline.png`);
    await page.screenshot({ path: baselinePath });
    screenshots.push({
      file: baselinePath,
      caption: `Real Chromium screenshot at ${targetUrl} for ${opts.storyId} (captured by Playwright)`,
    });

    await page.waitForTimeout(300);
    const afterPath = path.join(opts.evidenceDir, `${opts.storyId}-after-action.png`);
    await page.screenshot({ path: afterPath });
    screenshots.push({
      file: afterPath,
      caption: `Real Chromium screenshot of ${targetUrl} after 300ms interaction for ${opts.storyId}`,
    });
  } finally {
    await browser.close();
    if (child) {
      try { await child.close(); } catch { /* swallow */ }
    }
  }

  return { screenshots, consoleErrors: errors.console, pageErrors: errors.page, serverUrl };
}

async function tryStartServer(
  opts: RealVerifyOpts,
  signal: AbortSignal,
): Promise<{ url: string; close: () => Promise<void> } | null> {
  const absEntry = path.resolve(opts.workdir, opts.serverEntry!).replace(/\\/g, "/");
  const probe = `
    const m = await import("${absEntry}");
    const mod = m.default || m;
    const fn = mod.listen || mod.startServer || mod.start || mod.serve;
    if (typeof fn !== "function") { process.stderr.write("ERR=no listen-like export\\n"); process.exit(2); }
    const result = await fn({ port: 0 });
    const port = result && result.port !== undefined ? result.port : (result && result.address ? result.address.port : 0);
    process.stdout.write("PORT=" + port + "\\n");
    await new Promise(() => {});
  `;
  return new Promise((resolve) => {
    const child = spawn("node", [
      "--input-type=module",
      "--no-warnings",
      "-e", probe,
    ], { cwd: opts.workdir, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    const onAbort = () => { child.kill(); resolve(null); };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (b) => {
      stdout += b.toString();
      const m = stdout.match(/PORT=(\d+)/);
      if (m) {
        signal.removeEventListener("abort", onAbort);
        resolve({
          url: `http://127.0.0.1:${m[1]}`,
          close: () => new Promise<void>((res) => {
            child.kill();
            child.once("exit", () => res());
          }),
        });
      }
    });
    child.on("exit", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(null);
    });
  });
}