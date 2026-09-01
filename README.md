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

## License

MIT