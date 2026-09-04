import type { CSSProperties, ReactNode } from "react";

/**
 * Small, dense numeric label that pairs a big mono number with a one-line
 * caption. Designed to live in the KPI row of the fleet overview.
 *
 * The number is the hero; the caption is the subtitle. We resist the urge
 * to decorate the tile — restraint is the point.
 */

export interface KpiTileProps {
    label: string;
    value: ReactNode;
    /** Optional delta string ("+3", "−1", "78%"). */
    delta?: string;
    /** Direction of the delta — sets the signal color. */
    deltaTone?: "up" | "down" | "neutral";
    /** Optional footnote for caveats ("last 7 days"). */
    footnote?: string;
    style?: CSSProperties;
}

export function KpiTile(props: KpiTileProps) {
    const { label, value, delta, deltaTone = "neutral", footnote, style } = props;
    return (
        <article className="kpi" style={style}>
            <div className="kpi__label">{label}</div>
            <div className="kpi__value mono">{value}</div>
            <div className="kpi__row">
                    {delta && (
                        <span className={`kpi__delta kpi__delta--${deltaTone} mono`}>
                            {delta}
                        </span>
                    )}
                    {footnote && <span className="kpi__foot">{footnote}</span>}
                </div>
        </article>
    );
}