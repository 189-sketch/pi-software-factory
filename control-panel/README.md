# factory · control panel

A visual control panel for the multi-agent software factory.

```
npm install
npm run dev        # vite @ http://localhost:5174
npm run build      # tsc + vite build → dist/
npm run preview    # serve dist/ for a sanity check
```

## It reads real data, not mocks

The panel never holds a hardcoded project list. On every request it asks
a small Vite plugin (`vite/factoryApi.ts`) for the live state of the
factory repo it's running in. Endpoints:

| Path | Source |
| --- | --- |
| `/api/projects` | the current repo (from `package.json`) plus any repos declared in `.factory-daemon/.env` |
| `/api/projects/:id/issues` | `factory/state/<n>.json` (processed) + `fixtures/issues/*.json` (waiting) |
| `/api/events` | tail of `.factory/daemon.log`, parsed as `ISO LEVEL stage message {bindings}` |
| `/api/agents` | `skills/*/SKILL.md`, with name + description parsed from frontmatter |
| `/api/settings` | `ANTHROPIC_*` env, `FACTORY_POLL_INTERVAL` from `.factory-daemon/.env`, daemon state from log mtime + daemon-start timestamp |

If the factory hasn't run yet, the panel renders the empty state
honestly: 0 throughput, 0 merged, all issues parked at Triage.

## What it shows

- **Fleet** — every configured project, one card per project with its
  own conveyor showing where every issue is parked.
- **Project** — single project view: full-width conveyor, issue list,
  selected issue's stage timeline, recent events scoped to this project.
- **Agents** — the six SKILL.md agents, with their live skill body,
  description (from frontmatter), and LLM config.
- **Settings** — global LLM provider, local daemon state (active /
  uptime / workdir), structured log channel preview.

## The signature element

The conveyor. Each project page renders a horizontal rail with six
station bulbs (Triage · Spec · Implementation · Review · Verify · Merge).
Each issue in the project parks above the rail at its current station,
with a dashed leader line dropping to the belt. Stacked issues are
shown as one card + a `+N` indicator. The bulbs read the latest known
status of every issue at that station:

- **amber** — an agent is currently working at this station.
- **signal green** — every issue at this station has cleared it.
- **alert red** — a review or merge has failed at this station.
- **cool blue** — idle.

## Design language

- **Surface tokens** (`src/styles/tokens.css`): `--ink`, `--amber`,
  `--signal`, `--alert`, `--cool`. The dark surface is a warm blue-black,
  not pure `#000`, so the amber and signal lights read with real glow.
- **Type pairing**: Inter for UI labels, JetBrains Mono for IDs,
  timestamps, file paths, log lines, and metric values. Tabular numerals
  everywhere so KPIs align.
- **Restraint**: no drop shadows, no rounded everything. A single-pixel
  rail line is the dominant motif. Cards have a 2px corner radius; the
  whole thing reads as a flat control panel, not a dashboard.

## Layout

The view is full-width — there is no max-width ceiling. KPI tiles, the
fleet grid, project conveyor, and settings grid all flex with the
viewport. Breakpoints at 1100px and 720px stack grids rather than
squeeze them.