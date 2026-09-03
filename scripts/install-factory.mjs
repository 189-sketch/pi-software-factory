#!/usr/bin/env node
/**
 * Installer for the software factory.
 *
 * Lets the user choose between:
 *   1. cloud  — GitHub Actions trigger the factory in cloud VMs (secrets
 *                live as repo secrets, no local process needed)
 *   2. local  — A local daemon polls GitHub for new issues and processes
 *                them on this machine (secrets stay local, only finished
 *                commits/PRs reach GitHub)
 *   3. both   — Install both; user can switch between modes
 *
 * Usage:
 *   # Interactive (asks which mode)
 *   node scripts/install-factory.mjs /path/to/to/target-repo
 *
 *   # Non-interactive (CI)
 *   node scripts/install-factory.mjs /path/to/to/target-repo --mode cloud
 *   node scripts/install-factory.mjs /path/to/to/target-repo --mode local
 *   node scripts/install-factory.mjs /path/to/to/target-repo --mode both
 *
 * What this installer does:
 *   - Copies .agents/skills/ and the factory/ code into the target repo
 *   - Copies .github/workflows/ ONLY if --mode=cloud|both
 *   - Writes a README section explaining how to run the chosen mode
 *   - Wires the local daemon (only if --mode=local|both):
 *       * creates .factory-daemon/ with start.sh + factory-daemon.service
 *       * prompts for GH_TOKEN, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_BASE_URL
 *       * stores them in .factory-daemon/.env (chmod 600)
 *       * optionally installs systemd / launchd unit
 */
import { execFileSync } from "node:child_process";
import { promises as fs, mkdirSync, writeFileSync, existsSync, chmodSync, statSync, copyFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const factoryRoot = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") out.mode = argv[++i];
    else if (a === "--repo") out.repo = argv[++i];
    else if (a === "--non-interactive" || a === "-y") out.yes = true;
    else if (a === "--install-service") out.installService = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else out._.push(a);
  }
  return out;
}

async function ask(question, options, defaultIdx = 0) {
  if (process.env.NON_INTERACTIVE || process.argv.includes("-y")) {
    return options[defaultIdx];
  }
  console.log(question);
  options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(`Choose [1-${options.length}] (default ${defaultIdx + 1}): `);
  rl.close();
  const idx = Number(answer) - 1;
  return options[idx] !== undefined ? options[idx] : options[defaultIdx];
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

async function copyFileOr(src, dst) {
  if (!existsSync(src)) return;
  await fs.mkdir(path.dirname(dst), { recursive: true });
  await fs.copyFile(src, dst);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    console.log("Usage: node scripts/install-factory.mjs <target-repo-path> [--mode cloud|local|both] [--repo <owner/name>] [--install-service]");
    process.exit(args.help ? 0 : 1);
  }

  const target = path.resolve(args._[0]);
  const mode = args.mode || await ask(
    "Which mode do you want to enable?",
    [
      "cloud  — GitHub Actions runs the factory in ephemeral VMs",
      "local  — A local daemon polls/issues + processes them on this machine",
      "both   — Install both; pick at runtime",
    ],
    1, // default to local
  );

  const repo = args.repo || "";
  console.log(`\nInstalling factory into: ${target}`);
  console.log(`Mode: ${mode}\n`);

  // 1. Copy skills/ → .agents/skills/ in target (matches the demo's path
  //    convention) AND into factory/skills/ (the CLI resolves SKILL.md
  //    via ../../skills relative to its own src/cli directory, so the
  //    factory/ subdir must have its own copy).
  if (existsSync(path.join(factoryRoot, "skills"))) {
    await copyDir(path.join(factoryRoot, "skills"), path.join(target, ".agents", "skills"));
    await copyDir(path.join(factoryRoot, "skills"), path.join(target, "factory", "skills"));
    console.log("✓ Copied skills/ → .agents/skills/ + factory/skills/");
  }

  // 2. Copy the agent runner code as factory/ in the target. The standalone
  //    project keeps the agent code at the repo root (src/, package.json,
  //    tsconfig.json); we copy those into a factory/ subdir so the daemon
  //    and the cloud workflows can find src/cli/run-issue.ts at the
  //    canonical path factory/src/cli/run-issue.ts.
  const agentSrc = path.join(factoryRoot, "src");
  if (existsSync(agentSrc)) {
    await copyDir(agentSrc, path.join(target, "factory", "src"));
    await copyFileOr(path.join(factoryRoot, "package.json"), path.join(target, "factory", "package.json"));
    await copyFileOr(path.join(factoryRoot, "tsconfig.json"), path.join(target, "factory", "tsconfig.json"));
    // Also copy the test fixtures the runner needs.
    if (existsSync(path.join(factoryRoot, "fixtures", "evidence"))) {
      await copyDir(path.join(factoryRoot, "fixtures", "evidence"), path.join(target, "factory", "fixtures", "evidence"));
    }
    if (existsSync(path.join(factoryRoot, "fixtures", "issues"))) {
      await copyDir(path.join(factoryRoot, "fixtures", "issues"), path.join(target, "factory", "fixtures", "issues"));
    }
    if (existsSync(path.join(factoryRoot, "scripts"))) {
      await copyDir(path.join(factoryRoot, "scripts"), path.join(target, "factory", "scripts"));
    }
    console.log("✓ Copied factory/ (agent runner code)");
  } else {
    console.log("(no src/ dir in factory source; skipping agent code copy)");
  }

  // 3. Cloud-specific: copy workflow templates to .github/workflows/
  if (mode === "cloud" || mode === "both") {
    const wfSrc = path.join(factoryRoot, "templates", "github", "workflows");
    if (existsSync(wfSrc)) {
      await copyDir(wfSrc, path.join(target, ".github", "workflows"));
      console.log("✓ Copied templates/github/workflows/ → .github/workflows/");
    }
    console.log("\n  ⚠ Set these secrets on the target repo via `gh secret set`:");
    console.log("    gh secret set ANTHROPIC_AUTH_TOKEN --repo <owner>/<repo>");
    console.log("    gh secret set ANTHROPIC_BASE_URL   --repo <owner>/<repo>");
    console.log("    gh secret set ANTHROPIC_MODEL      --repo <owner>/<repo>");
  }

  // 4. Local-specific: daemon + .env + (optional) service unit
  if (mode === "local" || mode === "both") {
    const daemonDir = path.join(target, ".factory-daemon");
    await fs.mkdir(daemonDir, { recursive: true });
    // Install daemon script.
    await fs.copyFile(path.join(factoryRoot, "scripts", "factory-daemon.mjs"), path.join(daemonDir, "factory-daemon.mjs"));
    // npm install in factory/ so tsx is available (idempotent). Resolves
    // npm from PATH so we don't need shell:true on Windows (avoids the
    // Node 22+ deprecation warning + EINVAL).
    try {
      const isWin = process.platform === "win32";
      let npmCmd;
      if (isWin) {
        const findOnPath = (name) => {
          const sep = ";";
          const dirs = (process.env.PATH || "").split(sep).filter(Boolean);
          for (const dir of dirs) {
            const full = path.join(dir, name);
            if (existsSync(full)) return full;
            if (!/\.[a-z]+$/i.test(name)) {
              for (const ext of (process.env.PATHEXT || "").split(";")) {
                const c2 = full + ext;
                if (existsSync(c2)) return c2;
              }
            }
          }
          return null;
        };
        npmCmd = findOnPath("npm.cmd");
      }
      execFileSync(npmCmd || "npm", ["install"], {
        cwd: path.join(target, "factory"),
        stdio: "ignore",
        shell: false,
      });
    } catch {}
    // Wrapper start.sh (POSIX). The daemon itself loads .env via its built-in
    // --env-file loader — keeps the wrapper free of bash dotenv quirks.
    const startSh = `#!/usr/bin/env bash
# Start the factory daemon. .env is loaded by the daemon itself.
set -euo pipefail
cd "$(dirname "$0")/.."
exec node .factory-daemon/factory-daemon.mjs "$@"
`;
    writeFileSync(path.join(daemonDir, "start.sh"), startSh);
    chmodSync(path.join(daemonDir, "start.sh"), 0o755);

    // Wrapper start.cmd (Windows). Likewise defers env loading to the daemon
    // — old code shell-parsed .env in cmd and silently failed (see git log).
    const startCmd = `@echo off
REM Start the factory daemon. .env is loaded by the daemon itself.
REM Usage:  start.cmd [extra args forwarded to factory-daemon.mjs]
setlocal
cd /D "%~dp0\\.."
where node >nul 2>nul
if errorlevel 1 (
  echo node.exe not found in PATH. Install Node.js 20+ from https://nodejs.org/.
  exit /b 1
)
node .factory-daemon\\factory-daemon.mjs %*
set "FACTORY_EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %FACTORY_EXIT_CODE%
`;
    writeFileSync(path.join(daemonDir, "start.cmd"), startCmd);
    console.log("✓ Wrote start.sh + start.cmd");
    // .env template.
    const envTpl = `# Generated by factory installer. Mode = local.
# Secrets live HERE, not on GitHub. File is chmod 600.
GH_TOKEN=ghp_replace_me
ANTHROPIC_AUTH_TOKEN=sk-ant-replace_me
ANTHROPIC_BASE_URL=
ANTHROPIC_MODEL=
FACTORY_AGENT_MODE=llm
FACTORY_GH_REPO=${repo || "owner/name"}
FACTORY_POLL_INTERVAL=30
`;
    writeFileSync(path.join(daemonDir, ".env.template"), envTpl);
    // Never overwrite an existing credential file during upgrades.
    const envPath = path.join(daemonDir, ".env");
    if (existsSync(envPath)) {
      console.log(`✓ Preserved existing ${envPath}`);
    } else if (!args.yes) {
      console.log("\n  Provide GitHub + LLM credentials for the local daemon:");
      const rl = readline.createInterface({ input, output });
      const ghTok = (await rl.question("  GH_TOKEN (or blank to set later): ")).trim();
      const antTok = (await rl.question("  ANTHROPIC_AUTH_TOKEN (or blank to set later): ")).trim();
      const baseUrl = (await rl.question("  ANTHROPIC_BASE_URL (or blank to use environment fallback): ")).trim();
      const model = (await rl.question("  ANTHROPIC_MODEL (or blank to use environment fallback): ")).trim();
      rl.close();
      const realEnv = `# Local factory daemon secrets (chmod 600)
GH_TOKEN=${ghTok || "ghp_replace_me"}
ANTHROPIC_AUTH_TOKEN=${antTok || "sk-ant-replace_me"}
ANTHROPIC_BASE_URL=${baseUrl}
ANTHROPIC_MODEL=${model}
FACTORY_AGENT_MODE=llm
FACTORY_GH_REPO=${repo || "owner/name"}
FACTORY_POLL_INTERVAL=30
`;
      writeFileSync(envPath, realEnv);
      chmodSync(envPath, 0o600);
      console.log(`✓ Wrote ${envPath} (chmod 600)`);
    } else {
      writeFileSync(envPath, envTpl.replace("ghp_replace_me", "REPLACE_ME"));
      chmodSync(envPath, 0o600);
      console.log(`✓ Wrote template ${envPath} - fill in before starting`);
    }

    // systemd / launchd / Windows service unit (optional).
    if (args.installService) {
      await installService(target, daemonDir);
    }

    // README addendum.
    const readme = path.join(target, "FACTORY_DAEMON.md");
    writeFileSync(readme, `# Factory Daemon (local mode)

This target repo has a factory daemon installed under \`.factory-daemon/\`.

## Run manually

\`\`\`
# Linux / macOS
./.factory-daemon/start.sh

# Windows (cmd or PowerShell)
.factory-daemon\\start.cmd
\`\`\`

The daemon polls \`$FACTORY_GH_REPO\` every \`$FACTORY_POLL_INTERVAL\` seconds,
processing any new issues end-to-end (triage → spec → implement → review →
verify → push).

## Run as a system service

\`\`\`
# systemd (Linux)
sudo systemctl enable --now $(pwd)/.factory-daemon/factory-daemon.service

# launchd (macOS)
cp .factory-daemon/com.github.factory-daemon.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.github.factory-daemon.plist

# Windows Service (PowerShell as Administrator)
.factory-daemon\\install-windows-service.ps1 -RepoPath "$(pwd)"
# Then:
net start FactoryDaemon
\`\`\`

The Windows installer auto-detects NSSM (preferred) or falls back to sc.exe.

## Secrets

Secrets live in \`.factory-daemon/.env\` (chmod 600), never on GitHub.

| Variable | Purpose |
|---|---|
| \`GH_TOKEN\` | \`gh\` CLI auth for pushing branches + creating PRs |
| \`ANTHROPIC_AUTH_TOKEN\` | LLM API auth |
| \`ANTHROPIC_BASE_URL\` | Anthropic-compatible base URL; required from an environment source |
| \`ANTHROPIC_MODEL\` | Model id; required from an environment source |
| \`FACTORY_GH_REPO\` | \`owner/name\` of the target repo |
| \`FACTORY_POLL_INTERVAL\` | Seconds between polls (default: 30) |

### Optional: skip the .env entirely

The daemon gracefully falls back when secrets aren't set in \`.env\`:

- \`GH_TOKEN\` — falls back to \`gh auth token\` (uses the active \`gh\` CLI
  login on this machine). If you've already run \`gh auth login\`, no token
  configuration is required.
- \`ANTHROPIC_AUTH_TOKEN\`, \`ANTHROPIC_BASE_URL\`, \`ANTHROPIC_MODEL\` — fall
  back to the \`env\` block of \`~/.claude/settings.json\`. If you have
  Claude Code configured there, the daemon reuses those credentials.

Explicit values in \`.env\` always win; real shell env wins over \`.env\`;
\`--no-env-file\` / \`--no-fallback-env\` disable each respectively.

## State

Each processed issue writes:
- \`.factory-daemon/state-<n>.json\` — full pipeline result
- \`.factory-daemon/daemon.log\` — line-delimited JSON log
`);
    console.log("✓ Wrote FACTORY_DAEMON.md");
  }

  console.log(`\n✅ Factory installed in mode: ${mode}`);
  console.log(`\nNext steps:`);
  if (mode === "cloud" || mode === "both") console.log("  1. gh secret set ANTHROPIC_AUTH_TOKEN --repo <owner>/<repo>");
  if (mode === "local" || mode === "both") console.log(`  1. ${mode === "local" ? "Fill in" : "Verify"} .factory-daemon/.env`);
  console.log("  2. Open a test issue on the target repo");
  if (mode === "cloud" || mode === "both") console.log("  3. The workflow will trigger automatically");
  if (mode === "local" || mode === "both") console.log("  3. Run ./.factory-daemon/start.sh — daemon polls every 30s");
}

async function installService(target, daemonDir) {
  const isWin = process.platform === "win32";
  if (isWin) {
    // Windows: copy the PowerShell service installer.
    await fs.copyFile(
      path.join(factoryRoot, "scripts", "install-windows-service.ps1"),
      path.join(daemonDir, "install-windows-service.ps1"),
    );
    console.log("✓ Wrote install-windows-service.ps1 — run it as Administrator to register the Windows service");
    return;
  }
  const unitName = "factory-daemon.service";
  const unit = `[Unit]
Description=Software Factory Daemon (local mode)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${target}
EnvironmentFile=${daemonDir}/.env
ExecStart=/usr/bin/env node ${daemonDir}/factory-daemon.mjs
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
`;
  writeFileSync(path.join(daemonDir, unitName), unit);

  // macOS launchd plist for completeness.
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.github.factory-daemon</string>
  <key>WorkingDirectory</key><string>${target}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>${daemonDir}/factory-daemon.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
  writeFileSync(path.join(daemonDir, "com.github.factory-daemon.plist"), plist);
  console.log("✓ Wrote systemd + launchd units");
}

main().catch((e) => { console.error(e); process.exit(1); });
