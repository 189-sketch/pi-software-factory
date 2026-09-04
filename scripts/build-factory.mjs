#!/usr/bin/env node
/**
 * Build the factory orchestrator and skills into a single distributable
 * bundle under dist/factory/.
 *
 * Why a bundle:
 *   - Target projects don't need TypeScript, tsx, or the source tree.
 *     They install the npm package and get a single JS file.
 *   - Skills are JSON, copied alongside the bundle so the daemon can
 *     load them without parsing Markdown frontmatter at runtime.
 *
 * Output:
 *   dist/factory/orchestrator.js   — single ESM bundle, all TS deps
 *                                     inlined, ready for daemon import
 *   dist/factory/skills/<id>.json  — pre-parsed skill bodies
 */
import { build } from "esbuild";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const factoryRoot = path.resolve(__dirname, "..");

async function main() {
    const outDir = path.join(factoryRoot, "dist", "factory");
    await fs.mkdir(outDir, { recursive: true });

    // Bundle the orchestrator + every agent it depends on into one ESM file.
    await build({
        entryPoints: [path.join(factoryRoot, "src", "orchestrator", "index.ts")],
        bundle: true,
        format: "esm",
        platform: "node",
        target: "node20",
        outfile: path.join(outDir, "orchestrator.js"),
        // Mark runtime packages as external — the daemon/CLI finds them
        // in the user's node_modules at install time. Playwright is
        // optional (only the verify-behavior agent needs it); if it's
        // missing, that agent is a no-op, the rest of the pipeline works.
        external: [
            "@mariozechner/pi-agent-core",
            "@mariozechner/pi-ai",
            "playwright-core",
            "playwright",
            "chromium-bidi",
        ],
        sourcemap: true,
        logLevel: "info",
    });

    // Skills: read every skills/<id>/SKILL.md, parse the frontmatter,
    // and dump a JSON blob alongside the bundle so the daemon doesn't
    // need Markdown parsing at runtime.
    const skillsSrc = path.join(factoryRoot, "skills");
    const skillsOut = path.join(outDir, "skills");
    await fs.mkdir(skillsOut, { recursive: true });
    const dirs = await fs.readdir(skillsSrc, { withFileTypes: true });
    let count = 0;
    for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const skillPath = path.join(skillsSrc, dir.name, "SKILL.md");
        let body;
        try {
            body = await fs.readFile(skillPath, "utf-8");
        } catch {
            continue;
        }
        const fmMatch = body.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
        let description = "";
        let name = dir.name;
        let tagsRaw = "";
        if (fmMatch) {
            const inner = fmMatch[1].replace(/\r\n?/g, "\n");
            const descMatch = inner.match(/^description:\s*(.+)$/m);
            if (descMatch) description = descMatch[1].trim();
            const nameMatch = inner.match(/^name:\s*(.+)$/m);
            if (nameMatch) name = nameMatch[1].trim();
            const tagsMatch = inner.match(/^tags:\s*(.+)$/m);
            if (tagsMatch) tagsRaw = tagsMatch[1].trim();
        }
        const tags = parseTags(tagsRaw);
        await fs.writeFile(
            path.join(skillsOut, `${dir.name}.json`),
            JSON.stringify({ id: dir.name, name, description, body, tags }),
            "utf-8",
        );
        count++;
    }

    // A small index the daemon reads to know what skills exist.
    await fs.writeFile(
        path.join(outDir, "skills", "index.json"),
        JSON.stringify({ skills: dirs.filter((d) => d.isDirectory()).map((d) => d.name) }),
        "utf-8",
    );

    console.log(`✓ Built orchestrator + ${ count } skills into ${ outDir }`);
}

function parseTags(raw) {
    const inner = raw.replace(/^\[|\]$/g, "");
    return inner
        .split(",")
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});