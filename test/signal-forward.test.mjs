/**
 * Verifies the factory CLI's `start` command actually forwards signals
 * to the spawned daemon child. Without this, daemon processes survive
 * Ctrl+C on POSIX and become zombies.
 *
 * Strategy: spawn `factory start --interval 1` (shortest possible poll
 * interval so the daemon stays busy) and send SIGTERM after a short
 * delay. The parent must exit within 7s; the daemon child must also
 * exit. We verify by checking that no factory-daemon.mjs process is
 * still alive afterward.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import process from "node:process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const factoryCli = path.resolve(__dirname, "..", "bin", "factory.js");

function listDaemonPids() {
    try {
        const stdout = execFileSync(
            process.platform === "win32" ? "tasklist" : "ps",
            process.platform === "win32"
                ? ["/FI", "IMAGENAME eq node.exe", "/FO", "CSV", "/NH"]
                : ["-eo", "pid,command"],
            { encoding: "utf-8" },
        );
        const lines = stdout.split(/\r?\n/).filter((l) => /factory-daemon/.test(l));
        return lines.length;
    } catch {
        return 0;
    }
}

test("factory start forwards SIGTERM to daemon and both exit", async () => {
    const before = listDaemonPids();
    const child = spawn(process.execPath, [
        factoryCli,
        "start",
        "--interval",
        "1",
        "--local-dir",
        "./nonexistent-issues-for-test",
    ], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FACTORY_POLL_INTERVAL: "1" },
    });

    // Capture stdout/stderr so a failing test can print them.
    const chunks = [];
    child.stdout.on("data", (b) => chunks.push(b));
    child.stderr.on("data", (b) => chunks.push(b));

    // Let the daemon start.
    await new Promise((r) => setTimeout(r, 1500));

    // SIGTERM the parent; it must propagate.
    child.kill("SIGTERM");

    // Parent should exit within 7s. Daemon child must exit too.
    const exit = await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("parent did not exit within 7s")), 7000);
        child.on("exit", (code, signal) => {
            clearTimeout(t);
            resolve({ code, signal });
        });
    });

    // Give the daemon child up to 5s to exit too.
    await new Promise((r) => setTimeout(r, 5000));

    const after = listDaemonPids();
    assert.ok(
        after <= before,
        `daemon processes leaked: before=${before} after=${after}\noutput:\n${Buffer.concat(chunks).toString()}`,
    );
});