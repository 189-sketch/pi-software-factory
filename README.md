# Pi Software Factory

A multi-agent software factory built on the [pi-mono](https://github.com/badlogic/pi-mono) framework. Driven by GitHub issues, it runs six independent agents — each owning its own `SKILL.md` — through a complete software-development pipeline:

```
new issue ─ → triage → spec → implementation → review → verify-behavior → merged PR
                            ↑                                       ↓
                            └─────── improve-review-pr (daily) ─────┘
```

## Six independent agents

| Agent                  | Skill                              | Triggered by                              |
| ---------------------- | ---------------------------------- | ----------------------------------------- |
| `TriageAgent`          | `skills/triage/SKILL.md`           | new GitHub issue                          |
| `SpecAgent`            | `skills/spec/SKILL.md`             | issue labeled `ready-to-spec`             |
| `ImplementationAgent`  | `skills/implementation/SKILL.md`   | issue labeled `ready-to-implement`        |
| `ReviewPrAgent`        | `skills/review-pr/SKILL.md`        | pull request opened / updated             |
| `VerifyBehaviorAgent`  | `skills/verify-behavior/SKILL.md`  | invoked by implementation/review for UI   |
| `ImproveReviewPrAgent` | `skills/improve-review-pr/SKILL.md`| daily scheduled outer loop                |

Each agent is an independent TypeScript module that loads one `SKILL.md` and
runs a pi-style agent loop (`plan → tool → observe → act → finalize`). The
`FactoryOrchestrator` wires them together through a state machine keyed by
GitHub issue labels.

## Two execution modes

The factory supports two interchangeable modes — picked per-run by env vars.

### Stub mode (default for tests)

```bash
npm test
```

Each agent uses deterministic, rule-based logic. Tests run fast with no
network.

### LLM mode (real MiniMax-M3 / Claude via pi-agent-core)

```bash
export ANTHROPIC_AUTH_TOKEN=...        # or ANTHROPIC_API_KEY
export ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
export ANTHROPIC_MODEL=MiniMax-M3

npm run triage    # runs every fixture issue through the full pipeline with the LLM
```

In LLM mode, every agent delegates the reasoning step to the configured LLM
through `@mariozechner/pi-agent-core`. The LLM picks tools, gathers evidence,
and emits the same structured result the stub mode produces.

## Quick start

```bash
git clone <this-repo>
cd pi-software-factory
npm install

# Stub mode (no API key needed)
node --test src/__tests__/*.test.mjs

# LLM mode (real MiniMax-M3)
ANTHROPIC_AUTH_TOKEN=... ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
  npm run triage

# Single issue
npx tsx src/cli/run-issue.ts --issue fixtures/issues/100-add-export-endpoint.json

# Webhook server (accepts real GitHub events on :8080)
npx tsx src/cli/run-issue.ts --webhook 8080
```

## Driving from a real GitHub repo

Copy `.github/workflows/*.yml` to your target repo's `.github/workflows/`.
The workflows fire on `issues.opened`, `issues.labeled`, and `pull_request`
events, then invoke `npx tsx src/cli/run-issue.ts` to drive the agents.

Set `FACTORY_REMOTE_PATH` (or pass `--remote /path/to/remote.git`) so the
implementation agent commits and pushes to a real git remote. Against an
actual GitHub repo, install the `gh` CLI and authenticate it; the
`ImplementationAgent` will push branches and record pull-request refs.

## Layout
```
.
├── src/
│   ├── agents/        # six independent agents
│   ├── core/          # types, skill loader, agent loop, tools, llm adapter
│   ├── orchestrator/  # state machine
│   ├── github/        # webhook server, git adapter, local fixtures
│   ├── cli/           # entry point
│   └── __tests__/     # end-to-end test suite
├── skills/            # one SKILL.md per agent
├── scripts/           # annotate-diff, validate-review, spec-check, collect-feedback
├── fixtures/issues/   # sample issues
├── templates/github/workflows/  # workflow templates
└── .github/workflows/            # active workflows
```

## Why pi-mono?

pi-mono's `@mariozechner/pi-agent-core` provides an `agent()` function that
spawns sub-agents, routes tool results, and lets each agent own its own skill
file. The factory uses the same primitives: each agent extends `BaseAgent`
(a pi-style agent loop), declares its tools in the constructor, and emits a
typed result. The orchestrator is a thin layer that manages the state
machine.

## Two run modes

The installer (`scripts/install-factory.mjs`) supports two run modes that
control where the agent code runs and where API keys live.

### Mode 1: Cloud (GitHub Actions)

Workflows in `.github/workflows/` run the factory inside ephemeral
GitHub-hosted runners. Secrets live as **GitHub repo secrets**. No local
process required.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/189-sketch/pi-software-factory/main/scripts/install-factory.sh) /path/to/target --mode cloud
gh secret set ANTHROPIC_AUTH_TOKEN --repo owner/name
gh secret set ANTHROPIC_BASE_URL   --repo owner/name   # optional
gh secret set ANTHROPIC_MODEL      --repo owner/name   # optional
```

### Mode 2: Local daemon

A polling daemon runs **on your machine** and watches a target GitHub
repo for new issues. Each issue is processed in a fresh local workdir.
API keys live in `.factory-daemon/.env` (chmod 600) and never leave
your box.

```bash
git clone https://github.com/<you>/my-app
cd my-app
node /path/to/pi-software-factory/scripts/install-factory.mjs . --mode local --repo <you>/my-app
nano .factory-daemon/.env

# run
./.factory-daemon/start.sh               # Linux / macOS
.factory-daemon\start.cmd                # Windows
# or as a service
sudo systemctl enable --now ./.factory-daemon/factory-daemon.service     # Linux
cp .factory-daemon/com.github.factory-daemon.plist ~/Library/LaunchAgents/   # macOS
launchctl load ~/Library/LaunchAgents/com.github.factory-daemon.plist
.factory-daemon\install-windows-service.ps1 -RepoPath "$pwd"             # Windows
net start FactoryDaemon
```

### Mode 3: Both

`--mode both` installs both; you can switch at runtime without re-installing.

### Local daemon: configuration

`.factory-daemon/.env` keys:

| Variable | Default | Purpose |
|---|---|---|
| `GH_TOKEN` | — | `gh` CLI auth |
| `ANTHROPIC_AUTH_TOKEN` | — | LLM API key |
| `ANTHROPIC_BASE_URL` | required | Anthropic-compatible base URL loaded from the environment |
| `ANTHROPIC_MODEL` | required | Model id loaded from the environment |
| `FACTORY_GH_REPO` | — | `owner/name` of the target repo |
| `FACTORY_POLL_INTERVAL` | `30` | Seconds between polls |

## Verified end-to-end against real GitHub

- **Factory source:** https://github.com/189-sketch/pi-software-factory
- **Target repo:** https://github.com/189-sketch/pi-software-factory-target
- **Real issue → PR (merged):** https://github.com/189-sketch/pi-software-factory-target/pull/2

12/12 checks pass against the original demo's contracts (see
`scripts/objective-benchmark.mjs`).

## License

MIT
