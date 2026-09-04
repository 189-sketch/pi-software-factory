import type { StageStatus } from "../data/types";

/**
 * Small status pills that share one shape. The shape carries the meaning;
 * the color follows the signal vocabulary (amber = running, signal = pass,
 * alert = fail, cool = info, low = idle).
 *
 * Used everywhere a label needs a state. Always mono, always one line tall.
 */

export function Pill(props: { children: React.ReactNode; tone?: "amber" | "signal" | "alert" | "cool" | "low" | "neutral" }) {
    const { children, tone = "neutral" } = props;
    return <span className={`pill pill--${tone} mono`}>{children}</span>;
}

export function StagePill({ status }: { status: StageStatus }) {
    const tone =
        status === "passed"
            ? "signal"
            : status === "running"
                ? "amber"
                : status === "failed"
                    ? "alert"
                    : status === "skipped"
                        ? "low"
                        : "cool";
    return <Pill tone={tone}>{status.toUpperCase()}</Pill>;
}

export function TriagePill({ state }: { state: string }) {
    const tone =
        state.includes("implement")
            ? "signal"
            : state.includes("spec")
                ? "amber"
                : state.includes("Wait")
                    ? "low"
                    : state.includes("Needs")
                        ? "alert"
                        : "cool";
    return <Pill tone={tone as any}>{state}</Pill>;
}