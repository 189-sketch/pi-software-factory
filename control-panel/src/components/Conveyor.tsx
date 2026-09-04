import { useMemo } from "react";
import type { ProjectIssue, StageId } from "../data/types";
import { useMeasure } from "../hooks/useMeasure";

/**
 * Conveyor — the signature element.
 *
 * Renders the factory pipeline as a horizontal rail with six stations:
 * triage → spec → implementation → review → verify → merge.
 *
 * The SVG viewBox tracks the container's actual width so the conveyor
 * always fills the available space. The vertical layout is fixed by the
 * station labels at top → bulb → card → rail → count at bottom.
 *
 * Each station has an indicator bulb that reads the latest state of every
 * issue in the project. Issues themselves float above the rail as small
 * workpiece cards, parked over the station they currently occupy.
 *
 * Why SVG and not flexbox: the geometry is the point. Stations need to
 * align to a vertical axis in shared across the whole dashboard, and the
 * rail itself is the connective tissue. SVG lets every curve and gap be
 * deliberate.
 */

export const STATION_LABELS: { id: StageId; label: string; sub: string }[] = [
    { id: "triage", label: "Triage", sub: "route" },
    { id: "spec", label: "Spec", sub: "design" },
    { id: "implementation", label: "Implementation", sub: "code" },
    { id: "review", label: "Review", sub: "inspect" },
    { id: "verify", label: "Verify", sub: "behave" },
    { id: "merge", label: "Merge", sub: "ship" },
];

export interface ConveyorProps {
    issues: ProjectIssue[];
    /** Optional minimum width; the SVG grows past this when it fits. */
    minWidth?: number;
    /** Optional selected issue ID — that card is highlighted. */
    selectedId?: string;
    onSelect?: (issueId: string) => void;
}

const CARD_W = 132;
const CARD_H = 34;
const STATION_R = 8;

export function Conveyor({ issues, minWidth = 600, selectedId, onSelect }: ConveyorProps) {
    const [containerRef, { width: measured }] = useMeasure<HTMLDivElement>();
    // Use measured width; fall back to minWidth until first measure.
    const W = Math.max(minWidth, Math.round(measured));

    // The rail visually extends edge-to-edge (modulo a 8px border gutter)
    // so the conveyor reads as a continuous belt, not a hanging ribbon.
    // Stations are inset by half a card width so cards parked at the
    // first/last stations don't clip the SVG box.
    const railInset = 8;
    const stationInset = CARD_W / 2 + 4;
    const innerW = W - stationInset * 2;
    const stationX = useMemo(() => {
        const step = innerW / (STATION_LABELS.length - 1);
        return STATION_LABELS.map((_, i) => stationInset + i * step);
    }, [innerW]);

    // Tally the latest known status per station across all issues
    const stationAggregate = STATION_LABELS.map((s, i) => {
        const onStation = issues.filter((it) => it.currentStage === s.id);
        const running = onStation.some((it) =>
            it.stages.find((st) => st.id === s.id)?.status === "running",
        );
        const failed = onStation.some((it) =>
            it.stages.find((st) => st.id === s.id)?.status === "failed",
        );
        const passed = onStation.length > 0
            && onStation.every((it) => {
                const status = it.stages.find((st) => st.id === s.id)?.status;
                return status === "passed" || status === "skipped";
            });
        return {
            x: stationX[i],
            count: onStation.length,
            running,
            failed,
            passed,
        };
    });

    // Group parked issues by station for the layered card stack
    const byStation: Record<string, ProjectIssue[]> = {};
    for (const s of STATION_LABELS) byStation[s.id] = [];
    for (const it of issues) byStation[it.currentStage].push(it);

    // Vertical layout (top → bottom):
    // —   station title (12px)
    // —   station sub   (24px)
    // —   bulb          (48px)
    // —   card          (60–94px)
    // —   rail          (94px)
    // —   station count (114px)
    const RAIL_Y = 94;
    const BULB_Y = 48;
    const LABEL_TOP = 4;
    const CARD_BOTTOM = RAIL_Y - 10;
    const H = 124;

    return (
        <div ref={containerRef} className="conveyor-frame">
            {W > 0 && (
                <svg
                    className="conveyor"
                    viewBox={`0 0 ${W} ${H}`}
                    preserveAspectRatio="xMidYMid meet"
                    width="100%"
                    role="img"
                    aria-label="factory conveyor"
                >
                    {/* rail — the the long line under everything */}
                    <line
                        x1={railInset}
                        x2={W - railInset}
                        y1={RAIL_Y}
                        y2={RAIL_Y}
                        className="conveyor__rail"
                    />
                    {/* roller marks — short ticks below the rail, signaling motion */}
                    {Array.from({ length: 60 }).map((_, i) => {
                        const x = railInset + (i / 59) * (W - railInset * 2);
                        return (
                            <line
                                key={i}
                                x1={x}
                                x2={x}
                                y1={RAIL_Y + 6}
                                y2={RAIL_Y + 10}
                                className="conveyor__tick"
                            />
                        );
                    })}

                    {/* station labels + lights */}
                    {STATION_LABELS.map((s, i) => {
                        const x = stationX[i];
                        const a = stationAggregate[i];
                        const tone = a.failed
                            ? "alert"
                            : a.running
                            ? "amber"
                            : a.passed
                            ? "signal"
                            : "cool";
                        const fill = `var(--status-${tone === "alert" ? "fail" : tone === "signal" ? "pass" : tone === "amber" ? "running" : "info"})`;
                        return (
                            <g key={s.id} transform={`translate(${x}, 0)`}>
                                <text
                                    className="conveyor__station-label"
                                    textAnchor="middle"
                                    y={LABEL_TOP + 14}
                                >
                                    {s.label.toUpperCase()}
                                </text>
                                <text
                                    className="conveyor__station-sub mono"
                                    textAnchor="middle"
                                    y={LABEL_TOP + 28}
                                >
                                    {s.sub}
                                </text>
                                <circle
                                    r={STATION_R + 6}
                                    cx={0}
                                    cy={BULB_Y}
                                    className="conveyor__station-halo"
                                    fill={fill}
                                    opacity={0.22}
                                />
                                <circle
                                    r={STATION_R}
                                    cx={0}
                                    cy={BULB_Y}
                                    className="conveyor__station-bulb"
                                    fill={fill}
                                />
                                <text
                                    className="conveyor__station-count mono"
                                    textAnchor="middle"
                                    y={RAIL_Y + 22}
                                >
                                    {a.count ? `${a.count}` : ""}
                                </text>
                            </g>
                        );
                    })}

                    {/* parked issue cards — single visible per station with a +N
                        indicator for stacks. Cards sit just above the rail with a
                        dashed leader line dropping to the belt. */}
                    {STATION_LABELS.map((s, i) => {
                        const x = stationX[i];
                        const stack = byStation[s.id] || [];
                        const top = stack[0];
                        const extra = stack.length - 1;
                        if (!top) return null;
                        const status = top.stages.find((st) => st.id === s.id)?.status || "pending";
                        const tone = status === "running"
                            ? "amber"
                            : status === "passed"
                            ? "signal"
                            : status === "failed"
                            ? "alert"
                            : status === "skipped"
                            ? "low"
                            : "cool";
                        const isSelected = top.id === selectedId;
                        const cardY = CARD_BOTTOM - CARD_H;
                        const isLastStation = i === STATION_LABELS.length - 1;
                        return (
                            <g key={`stack-${s.id}`}>
                                {/* leader line from card bottom-center to rail */}
                                <line
                                    x1={x}
                                    x2={x}
                                    y1={cardY + CARD_H}
                                    y2={RAIL_Y}
                                    className="conveyor__card-leader"
                                />
                                <g
                                    transform={`translate(${x - CARD_W / 2}, ${cardY})`}
                                    className={`conveyor__card conveyor__card--${tone} ${isSelected ? "is-selected" : ""}`}
                                    onClick={() => onSelect?.(top.id)}
                                    style={{ cursor: onSelect ? "pointer" : "default" }}
                                >
                                    <rect
                                        x={0}
                                        y={0}
                                        width={CARD_W}
                                        height={CARD_H}
                                        className="conveyor__card-rect"
                                        rx={2}
                                    />
                                    <text x={8} y={14} className="conveyor__card-id mono">
                                        {top.id.replace(/^.*#/, "#")}
                                    </text>
                                    <text x={8} y={27} className="conveyor__card-title">
                                        {truncate(top.title, 18)}
                                    </text>
                                    <rect
                                        x={CARD_W - 4}
                                        y={6}
                                        width={3}
                                        height={CARD_H - 12}
                                        className={`conveyor__card-bar conveyor__card-bar--${tone}`}
                                    />
                                </g>
                                {extra > 0 && (
                                    <g
                                        transform={`translate(${isLastStation ? x - CARD_W / 2 - 32 : x + CARD_W / 2 + 6}, ${cardY + 6})`}
                                    >
                                        <rect
                                            x={0}
                                            y={-9}
                                            width={26}
                                            height={18}
                                            className="conveyor__more-bg"
                                            rx={2}
                                        />
                                        <text
                                            x={13}
                                            y={4}
                                            textAnchor="middle"
                                            className="conveyor__more mono"
                                        >
                                            +{extra}
                                        </text>
                                    </g>
                                )}
                            </g>
                        );
                    })}
                </svg>
            )}
        </div>
    );
}

function truncate(s: string, n: number) {
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
}