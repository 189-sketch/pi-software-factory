import { useEffect, useRef, useState } from "react";

/**
 * useMeasure — track the rendered size of an element via ResizeObserver.
 *
 * Returns a [ref, rect] pair. Attach the ref to any DOM element; the rect
 * updates on every size change. The observer is started lazily, so the
 * element must be mounted (typically inside a parent's render tree) for
 * the first measurement to come through.
 */
export function useMeasure<T extends HTMLElement = HTMLDivElement>(): [
    React.RefObject<T>,
    { width: number; height: number },
] {
    const ref = useRef<T>(null);
    const [rect, setRect] = useState({ width: 0, height: 0 });

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            const entry = entries[0];
            if (!entry) return;
            const cr = entry.contentRect;
            setRect({ width: cr.width, height: cr.height });
        });
        ro.observe(el);
        // Measure once on mount, in case ResizeObserver hasn't yet.
        const cr = el.getBoundingClientRect();
        setRect({ width: cr.width, height: cr.height });
        return () => ro.disconnect();
    }, []);

    return [ref, rect];
}