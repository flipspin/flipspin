import { useLayoutEffect, useRef, useState, type RefObject } from "react";

type Options = {
  scrollRef: RefObject<HTMLDivElement | null>;
  toolbarRef: RefObject<HTMLDivElement | null>;
  stackRef: RefObject<HTMLDivElement | null>;
  sentinelRef: RefObject<HTMLDivElement | null>;
  rowsStartRef: RefObject<HTMLDivElement | null>;
  filterKey: string;
  layout: string;
};

/** Measure only on layout changes. Scroll frames update a data attribute via IO. */
export function useLibraryScrollStack({ scrollRef, toolbarRef, stackRef, sentinelRef, rowsStartRef, filterKey, layout }: Options) {
  const [metrics, setMetrics] = useState({ scrollMargin: 0, stackHeight: 0 });
  const previousFilters = useRef(filterKey);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const toolbar = toolbarRef.current;
    const stack = stackRef.current;
    const sentinel = sentinelRef.current;
    const rows = rowsStartRef.current;
    if (!scroller || !toolbar || !stack || !sentinel || !rows) return;
    const changedFilters = previousFilters.current !== filterKey;
    previousFilters.current = filterKey;
    const wasStuck = scroller.dataset.stuck === "true";
    const measure = () => {
      const rootTop = scroller.getBoundingClientRect().top + scroller.clientTop;
      const scrollMargin = rows.getBoundingClientRect().top - rootTop + scroller.scrollTop;
      const stackHeight = stack.getBoundingClientRect().height;
      scroller.style.setProperty("--stack-h", `${stackHeight}px`);
      setMetrics(previous => previous.scrollMargin === scrollMargin && previous.stackHeight === stackHeight
        ? previous : { scrollMargin, stackHeight });
      return { scrollMargin, stackHeight, rootTop };
    };
    const current = measure();
    // Filtering while pinned reveals result 1 instantly, retaining the stack.
    if (changedFilters && wasStuck) scroller.scrollTop = Math.max(0, current.scrollMargin - current.stackHeight);
    // Derive from the restored, browser-clamped offset before paint; IO takes over.
    scroller.dataset.stuck = String(sentinel.getBoundingClientRect().top < current.rootTop);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { measure(); });
    resize?.observe(toolbar);
    resize?.observe(stack);
    resize?.observe(scroller);
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(([entry]) => {
      if (entry) scroller.dataset.stuck = String(!entry.isIntersecting && entry.boundingClientRect.top < (entry.rootBounds?.top ?? current.rootTop));
    }, { root: scroller, threshold: [0, 1] });
    observer?.observe(sentinel);
    return () => { resize?.disconnect(); observer?.disconnect(); };
  }, [scrollRef, toolbarRef, stackRef, sentinelRef, rowsStartRef, filterKey, layout]);
  return metrics;
}
