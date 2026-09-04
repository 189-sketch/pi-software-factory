#!/usr/bin/env node
/**
 * Build the control panel and emit it into dist/panel/ at the package
 * root, so the npm tarball ships a single consolidated `dist/` tree.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const factoryRoot = path.resolve(__dirname, "..");
const panelDir = path.join(factoryRoot, "control-panel");
const outDir = path.join(factoryRoot, "dist", "panel");

if (!existsSync(path.join(panelDir, "node_modules"))) {
    await new Promise((resolve, reject) => {
        const npm = spawn("npm", ["install", "--no-audit", "--no-fund"], {
            cwd: panelDir,
            stdio: "inherit",
            shell: true,
        });
        npm.on("exit", (code) => code === 0 ? resolve() : reject(new Error("npm install failed")));
    });
}

await new Promise((resolve, reject) => {
    const build = spawn(
        process.execPath,
        [path.join("node_modules", "vite", "bin", "vite.js"), "build"],
        {
            cwd: panelDir,
            stdio: "inherit",
            env: { ...process.env, FACTORY_PANEL_OUTDIR: outDir },
        },
    );
    build.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`vite build exited ${code}`)));
});

console.log(`✓ Built panel into ${ outDir }`);