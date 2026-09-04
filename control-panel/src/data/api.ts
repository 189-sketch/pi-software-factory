/**
 * Real-time fetcher against the factory API exposed by the Vite plugin.
 *
 * Every call hits /api/* and returns the live state of the factory repo —
 * project list, persisted issue states, daemon log, agents, settings.
 * The control panel never holds mock data; if an endpoint returns empty,
 * the UI shows an empty state instead.
 *
 * Each function is a thin wrapper around fetch(). Errors are not swallowed —
 * the UI is expected to render the failure state from a thrown promise.
 */

import type {
    AgentConfig,
    FactoryEvent,
    GlobalSettings,
    Project,
    ProjectIssue,
    StageStatus,
} from "./types";

/* -------------------------------------------------------------------------- */
/* Wire-shape definitions (what the API actually returns).                     */
/* -------------------------------------------------------------------------- */

interface ProjectMetaWire {
    id: string;
    name: string;
    repo: string;
    defaultBranch: string;
    isCurrent: boolean;
}

interface ProjectMetricsWire {
    merged7d: number;
    rejected30d: number;
    approved30d: number;
    avgTimeToMergeMs: number | null;
    started24h: number;
    closed24h: number;
}

interface IssueWire {
    issue?: {
        number: number;
        title: string;
        body?: string;
        labels?: string[];
        author?: string;
        url?: string;
        createdAt?: string;
        comments?: { author: string; body: string; createdAt: string }[];
    };
    triage?: { state?: string; label?: string; comment?: string };
    specs?: { specBranch?: string; specPrUrl?: string };
    implementation?: {
        branch?: string;
        commitSha?: string;
        prUrl?: string;
        prNumber?: number;
        filesChanged?: string[];
        comment?: string;
    };
    review?: { verdict?: "APPROVE" | "REJECT"; body?: string };
    merged?: boolean;
    /** True when the issue came from `gh issue list` and hasn't been processed yet. */
    _discovered?: boolean;
}

interface SettingsWire {
    baseUrl: string;
    defaultModel: string;
    pollIntervalSec: number;
    localDaemon: {
        active: boolean;
        pid: number | null;
        uptimeSec: number;
        workdir: string;
    };
}

interface EventWire {
    id: string;
    ts: string;
    level: "INFO" | "WARN" | "ERROR";
    stage: string;
    projectId: string;
    message: string;
    bindings: Record<string, unknown>;
}

interface AgentWire {
    id: string;
    label: string;
    skillPath: string;
    skillBody: string;
    description: string;
    stage: string;
    tags: string[];
}

/* -------------------------------------------------------------------------- */
/* Fetch helpers                                                              */
/* -------------------------------------------------------------------------- */

async function get<T>(path: string): Promise<T> {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${path}`);
    return (await r.json()) as T;
}

/* -------------------------------------------------------------------------- */
/* Normalizers — wire shape → UI shape                                        */
/* -------------------------------------------------------------------------- */

const STAGE_IDS = [
    "triage",
    "spec",
    "implementation",
    "review",
    "verify",
    "merge",
] as const;

function deriveStage(issue: IssueWire): (typeof STAGE_IDS)[number] {
    if (issue.merged) return "merge";
    if (issue.review?.verdict) return "verify";
    if (issue.implementation?.prUrl && !issue.review?.verdict) return "review";
    if (issue.implementation?.filesChanged?.length) return "implementation";
    if (issue.specs?.specPrUrl) return "spec";
    return "triage";
}

function buildStages(issue: IssueWire) {
    const current = deriveStage(issue);
    const idx = STAGE_IDS.indexOf(current);
    return STAGE_IDS.map((id, i) => {
        const passed = i < idx;
        const active = i === idx;
        if (passed) return { id, status: "passed" as StageStatus };
        if (active) {
            if (id === "review" && issue.review?.verdict === "REJECT") {
                return { id, status: "failed" as StageStatus };
            }
            if (issue._discovered && i > 0) {
                return { id, status: "skipped" as StageStatus };
            }
            return { id, status: "running" as StageStatus };
        }
        return { id, status: "pending" as StageStatus };
    });
}

function issueFromWire(projectId: string, wire: IssueWire): ProjectIssue | null {
    const i = wire.issue;
    if (!i) return null;
    const currentStage = deriveStage(wire);
    const stages = buildStages(wire);
    let summary = wire._discovered
        ? "Open on GitHub — factory hasn't picked it up yet"
        : "Awaiting triage";
    if (currentStage === "spec") summary = wire.specs?.specBranch ?? "Drafting PRODUCT.md + TECH.md";
    if (currentStage === "implementation") summary = wire.implementation?.comment ?? "Implementing";
    if (currentStage === "review") summary = "Reading diff and emitting review.json";
    if (currentStage === "verify") summary = wire.review?.verdict === "APPROVE" ? "Approved — running browser verify" : "Awaiting review";
    if (currentStage === "merge") summary = wire.merged ? "Merged" : "Merging PR";

    return {
        id: `${projectId}#${i.number}`,
        projectId,
        number: i.number,
        title: i.title,
        author: i.author ?? "unknown",
        openedAt: i.createdAt ?? new Date().toISOString(),
        labels: i.labels ?? [],
        currentStage,
        stages: stages.map((s, n) => ({
            id: s.id,
            status: s.status,
            summary: n === stages.findIndex((x) => x.id === currentStage) ? summary : undefined,
            artifact: wire.implementation?.prUrl && s.id === "implementation" ? wire.implementation.prUrl : undefined,
        })),
        url: i.url,
        prUrl: wire.implementation?.prUrl,
        branch: wire.implementation?.branch,
        lastComment: wire.triage?.comment,
    };
}

function projectFromWire(
    p: ProjectMetaWire,
    issues: IssueWire[],
    metrics: ProjectMetricsWire | null | undefined,
): Project {
    return {
        id: p.id,
        name: p.name,
        repo: p.repo,
        defaultBranch: p.defaultBranch,
        recentThroughput: metrics?.merged7d ?? 0,
        approved30d: metrics?.approved30d ?? 0,
        rejected30d: metrics?.rejected30d ?? 0,
        avgTimeToMergeMs: metrics?.avgTimeToMergeMs ?? null,
        started24h: metrics?.started24h ?? 0,
        closed24h: metrics?.closed24h ?? 0,
        issues: issues
            .map((w) => issueFromWire(p.id, w))
            .filter((x): x is ProjectIssue => x !== null),
    };
}

function agentsFromWire(wire: AgentWire[]): AgentConfig[] {
    return wire.map((a) => ({
        id: a.stage as AgentConfig["id"],
        label: a.label,
        skillPath: a.skillPath,
        skillBody: a.skillBody,
        description: a.description,
        mode: "llm",
        model: "MiniMax-M3",
        promptOverride: "",
        enabled: true,
        tags: a.tags ?? [],
    }));
}

function eventsFromWire(wire: EventWire[]): FactoryEvent[] {
    return wire.map((e) => ({
        id: e.id,
        ts: e.ts,
        level: e.level,
        projectId: e.projectId,
        stage: (STAGE_IDS as readonly string[]).includes(e.stage) ? (e.stage as FactoryEvent["stage"]) : "system",
        message: e.message,
        bindings: Object.fromEntries(
            Object.entries(e.bindings).map(([k, v]) => [k, typeof v === "string" || typeof v === "number" ? v : JSON.stringify(v)]),
        ),
    }));
}

function settingsFromWire(wire: SettingsWire): GlobalSettings {
    return {
        baseUrl: wire.baseUrl,
        defaultModel: wire.defaultModel,
        pollIntervalSec: wire.pollIntervalSec,
        localDaemon: {
            active: wire.localDaemon.active,
            pid: wire.localDaemon.pid,
            uptimeSec: wire.localDaemon.uptimeSec,
            workdir: wire.localDaemon.workdir,
        },
    };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export async function fetchProjects(): Promise<Project[]> {
    const r = await get<{ projects: ProjectMetaWire[]; metrics: Record<string, ProjectMetricsWire> }>(
        "/api/projects",
    );
    const out: Project[] = [];
    for (const p of r.projects) {
        try {
            const detail = await get<{ issues: IssueWire[] }>(`/api/projects/${p.id}/issues`);
            out.push(projectFromWire(p, detail.issues, r.metrics?.[p.id] ?? null));
        } catch {
            out.push(projectFromWire(p, [], r.metrics?.[p.id] ?? null));
        }
    }
    return out;
}

export async function fetchAgents(): Promise<AgentConfig[]> {
    const r = await get<{ agents: AgentWire[] }>("/api/agents");
    return agentsFromWire(r.agents);
}

export async function fetchEvents(): Promise<FactoryEvent[]> {
    const r = await get<{ events: EventWire[] }>("/api/events");
    return eventsFromWire(r.events);
}

export async function fetchSettings(): Promise<GlobalSettings> {
    return settingsFromWire(await get<SettingsWire>("/api/settings"));
}