import type { FactoryEvent } from "../data/types";

/**
 * EventStream — terminal-flavored log of factory events.
 *
 * Each row is one event. The first column is the timestamp (mono),
 * the second is the level, the third is the project/agent, and the
 * remaining space is the message + bindings. Color is reserved for the
 * level badge; the body is text-only.
 */

export interface EventStreamProps {
    events: FactoryEvent[];
    /** Optional cap on rows shown. Older rows scroll off. */
    maxRows?: number;
}

export function EventStream({ events, maxRows = 60 }: EventStreamProps) {
    const rows = events.slice(0, maxRows);
    return (
        <div className="events" role="log">
            <div className="events__head">
                <span className="events__head-cell" style={{ width: 84 }}>TIMESTAMP</span>
                <span className="events__head-cell" style={{ width: 56 }}>LEVEL</span>
                <span className="events__head-cell" style={{ width: 110 }}>PROJECT</span>
                <span className="events__head-cell" style={{ width: 130 }}>STAGE</span>
                <span className="events__head-cell" style={{ flex: 1 }}>MESSAGE</span>
            </div>
            <ul className="events__list">
                {rows.map((e) => (
                    <li key={e.id} className={`events__row events__row--${e.level.toLowerCase()}`}>
                        <span className="events__cell events__ts mono">{e.ts.slice(11, 19)}</span>
                        <span className={`events__cell events__level events__level--${e.level.toLowerCase()}`}>{e.level}</span>
                        <span className="events__cell events__proj mono">{e.projectId}</span>
                        <span className="events__cell events__stage mono">{e.stage}</span>
                        <span className="events__cell events__msg">
                            {e.message}
                            {e.bindings && (
                                <span className="events__bindings mono">
                                    {Object.entries(e.bindings ?? {}).map(([k, v], i) => (
                                        <span key={k} className="events__binding">
                                            <span className="events__binding-key">{k}</span>
                                            <span className="events__binding-eq">=</span>
                                            <span className="events__binding-val">{String(v)}</span>
                                            {i < Object.keys(e.bindings ?? {}).length - 1 && <span className="events__binding-sep">, </span>}
                                        </span>
                                    ))}
                                </span>
                            )}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}