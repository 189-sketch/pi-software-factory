import { useMemo } from "react";
import { Conveyor, STATION_LABELS } from "../components/Conveyor";
import { KpiTile } from "../components/KpiTile";
import { Pill, StagePill } from "../components/Chips";
import type { Project, ProjectIssue, StageStatus } from "../data/types";

/**
 * FleetView — the top-level multi-project dashboard.
 *
 * The page opens with a row of KPI tiles that aggregate across every
 * project, then walks through each project as a "line on the floor":
 * its name, the conveyor showing where its issues are parked, and a
 * one-line telemetry strip underneath.
 *
 * Designed to read at a glance: "the factory has 5 active issues, 1 of
 * them is in review and 2 are waiting on the spec agent."
 */

export interface FleetViewProps {
    projects: Project[];
    onSelectProject: (projectId: string) => void;
    onSelectIssue: (projectId: string, issueId: string) => void;
}

export function FleetView({ projects, onSelectProject, onSelectIssue }: FleetViewProps) {
    const aggregates = useMemo(() => {
        const all = projects.flatMap((p) => p.issues);
        const active = all.filter((i) =>
            i.stages.some((s) => s.status === "running"),
        );
        const totalIssues = all.length;
        const started24h = projects.reduce((s, p) => s + p.started24h, 0);
        const closed24h = projects.reduce((s, p) => s + p.closed24h, 0);
        const merged7d = projects.reduce((s, p) => s + p.recentThroughput, 0);
        const approved30d = projects.reduce((s, p) => s + p.approved30d, 0);
        const rejected30d = projects.reduce((s, p) => s + p.rejected30d, 0);
        // Average across projects that actually have merges.
        const mergeDurations = projects
            .map((p) => p.avgTimeToMergeMs)
            .filter((v): v is number => v !== null);
        const mergeCount = mergeDurations.length;
        const avgMs =
            mergeCount > 0
                ? Math.round(mergeDurations.reduce((a, b) => a + b, 0) / mergeCount)
                : null;
        const bottleneck = (() => {
            const counts: Record<string, number> = {};
            for (const i of active) counts[i.currentStage] = (counts[i.currentStage] || 0) + 1;
            const entries = Object.entries(counts);
            entries.sort((a, b) => b[1] - a[1]);
            return entries[0]?.[0] || "—";
        })();
        return { active, totalIssues, started24h, closed24h, merged7d, approved30d, rejected30d, avgMs, mergeCount, bottleneck };
    }, [projects]);

    return (
        <div className="view view--fleet">
            <header className="view__header">
                <div>
                    <div className="view__eyebrow mono">FLEET · ALL PROJECTS</div>
                    <h1 className="view__title">
                        <span className="mono">{aggregates.active.length}</span> active issues
                        across <span className="mono">{projects.length}</span> projects.
                    </h1>
                    <p className="view__sub">
                        {aggregates.bottleneck === "—" ? (
                            <>No agents are currently working. Pick an issue to wake the factory up.</>
                        ) : (
                            <>
                                The bottleneck station is{" "}
                                <span className="mono">{aggregates.bottleneck}</span>.
                            </>
                        )}
                    </p>
                </div>
            </header>

            <section className="kpi-row">
                <KpiTile
                    label="ACTIVE ISSUES"
                    value={aggregates.active.length}
                    delta={
                        aggregates.started24h === aggregates.closed24h
                            ? "0"
                            : aggregates.started24h > aggregates.closed24h
                            ? `+${aggregates.started24h - aggregates.closed24h}`
                            : `−${aggregates.closed24h - aggregates.started24h}`
                    }
                    deltaTone={
                        aggregates.started24h === aggregates.closed24h
                            ? "neutral"
                            : aggregates.started24h > aggregates.closed24h
                            ? "down"
                            : "up"
                    }
                    footnote={`${aggregates.started24h} started · ${aggregates.closed24h} closed (24h)`}
                />
                <KpiTile
                    label="THROUGHPUT · 7D"
                    value={aggregates.merged7d}
                    footnote={
                        aggregates.merged7d > 0
                            ? `${projects.length} projects`
                            : "no merges this week"
                    }
                />
                <KpiTile
                    label="MERGED · 30D"
                    value={aggregates.approved30d}
                    footnote={aggregates.approved30d > 0 ? "review verdict APPROVE" : "no approvals yet"}
                />
                <KpiTile
                    label="REJECTED · 30D"
                    value={aggregates.rejected30d}
                    deltaTone={aggregates.rejected30d === 0 ? "neutral" : "down"}
                    footnote={aggregates.rejected30d > 0 ? "review verdict REJECT" : "no rejections"}
                />
                <KpiTile
                    label="AVG TIME-TO-MERGE"
                    value={aggregates.avgMs === null ? "—" : formatDuration(aggregates.avgMs)}
                    footnote={
                        aggregates.avgMs === null
                            ? "no merges recorded yet"
                            : `across ${aggregates.mergeCount} merged issue${aggregates.mergeCount === 1 ? "" : "s"}`
                    }
                />
            </section>

            <section className="fleet-projects">
                {projects.map((p) => (
                    <article key={p.id} className="fleet-card">
                        <header className="fleet-card__head">
                            <div>
                                <div className="fleet-card__eyebrow mono">PROJECT · {p.repo}</div>
                                <h2 className="fleet-card__title">{p.name}</h2>
                            </div>
                            <div className="fleet-card__head-right">
                                <KpiTile
                                    label="MERGE RATE · 30D"
                                    value={
                                        p.approved30d + p.rejected30d === 0
                                            ? "—"
                                            : `${Math.round((p.approved30d / Math.max(1, p.approved30d + p.rejected30d)) * 100)}%`
                                    }
                                    delta={`${p.recentThroughput}/wk`}
                                    deltaTone={
                                        p.recentThroughput === 0
                                            ? "neutral"
                                            : p.approved30d >= p.rejected30d
                                            ? "up"
                                            : "down"
                                    }
                                    style={{ minWidth: 200 }}
                                />
                                <button
                                    className="btn btn--ghost"
                                    onClick={() => onSelectProject(p.id)}
                                >
                                    Open project →
                                </button>
                            </div>
                        </header>
                        <div className="fleet-card__conveyor">
                            <Conveyor
                                issues={p.issues}
                                onSelect={(id) => onSelectIssue(p.id, id)}
                            />
                        </div>
                        <footer className="fleet-card__foot">
                            <span className="mono">{p.issues.length} issues on the line</span>
                            {STATION_LABELS.map((s) => {
                                const count = p.issues.filter((i) => i.currentStage === s.id).length;
                                if (!count) return null;
                                return (
                                    <span key={s.id} className="fleet-card__foot-cell">
                                        <span className="fleet-card__foot-key mono">{s.label}</span>
                                        <span className="mono">{count}</span>
                                    </span>
                                );
                            })}
                        </footer>
                    </article>
                ))}
            </section>

            <section className="fleet-issues">
                <header className="section-head">
                    <h3 className="section-head__title">All issues on the line</h3>
                    <div className="section-head__hint mono">
                        {aggregates.totalIssues} TOTAL · SORTED BY STAGE
                    </div>
                </header>
                <table className="issues-table">
                    <thead>
                        <tr>
                            <th style={{ width: 80 }}>ID</th>
                            <th>Title</th>
                            <th style={{ width: 100 }}>Project</th>
                            <th style={{ width: 130 }}>Stage</th>
                            <th style={{ width: 90 }}>Status</th>
                            <th style={{ width: 130 }}>Opened</th>
                        </tr>
                    </thead>
                    <tbody>
                        {projects.flatMap((p) => p.issues)
                            .slice()
                            .sort((a, b) => STATION_LABELS.findIndex((s) => s.id === a.currentStage) - STATION_LABELS.findIndex((s) => s.id === b.currentStage))
                            .map((it) => (
                            <IssueRow
                                key={it.id}
                                issue={it}
                                projectName={it.projectId}
                                onSelect={() => onSelectIssue(it.projectId, it.id)}
                            />
                        ))}
                    </tbody>
                </table>
            </section>
        </div>
    );
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const rest = sec % 60;
    if (min < 60) return rest === 0 ? `${min}m` : `${min}m ${rest}s`;
    const hr = Math.floor(min / 60);
    const mRest = min % 60;
    return mRest === 0 ? `${hr}h` : `${hr}h ${mRest}m`;
}

function IssueRow({
    issue,
    projectName,
    onSelect,
}: {
    issue: ProjectIssue;
    projectName: string;
    onSelect: () => void;
}) {
    const stage = issue.stages.find((s) => s.id === issue.currentStage);
    return (
        <tr onClick={onSelect} style={{ cursor: "pointer" }}>
            <td className="mono">#{issue.number}</td>
            <td className="issues-table__title">{issue.title}</td>
            <td>
                <Pill tone="neutral">{projectName}</Pill>
            </td>
            <td className="mono">{issue.currentStage}</td>
            <td>
                <StagePill status={(stage?.status || "pending") as StageStatus} />
            </td>
            <td className="mono">{issue.openedAt.slice(0, 10)}</td>
        </tr>
    );
}