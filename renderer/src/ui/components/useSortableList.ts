import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";

const EDGE = 36;
const MAX_SCROLL = 14;
type Drag = {
  from: number; over: number; pointerId: number;
  startY: number; y: number; startScroll: number;
  mids: number[]; step: number; raf: number;
};
type Options = {
  count: number;
  onReorder: (from: number, to: number) => void;
  liftedClass: string;
  rowGap?: number;
  scrollerRef?: RefObject<HTMLElement | null>;
  enabled?: boolean;
};

/** Queue-style pointer capture sorting. Never HTML5 drag-and-drop: Tauri's
 * native file-drop handler swallows dragover/drop inside the webview.
 * Only the lifted row is painted on pointermove; order commits once on release.
 */
export function useSortableList({ count, onReorder, liftedClass, rowGap = 0, scrollerRef, enabled = true }: Options) {
  const { t } = useTranslation();
  const rows = useRef<HTMLElement[]>([]);
  // Live drag geometry; kept in a ref so pointermove never re-renders the list.
  const drag = useRef<Drag | null>(null);
  const [active, setActive] = useState<{ from: number; over: number } | null>(null);
  // One render without transitions after a drop: React has already moved the
  // DOM, so animating the siblings' transforms back to 0 would slide them twice.
  const [settling, setSettling] = useState(false);
  const [announce, setAnnounce] = useState("");
  const focusAfter = useRef<number | null>(null);

  useEffect(() => {
    if (!settling) return;
    const id = requestAnimationFrame(() => setSettling(false));
    return () => cancelAnimationFrame(id);
  }, [settling]);

  useLayoutEffect(() => {
    if (focusAfter.current == null) return;
    rows.current[focusAfter.current]?.querySelector<HTMLButtonElement>("[data-sortable-grip]")?.focus();
    focusAfter.current = null;
  });

  const place = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    const scroller = scrollerRef?.current;
    const dy = d.y - d.startY + ((scroller?.scrollTop ?? 0) - d.startScroll);
    const el = rows.current[d.from];
    if (el) el.style.transform = `translateY(${dy}px)`;
    // The grabbed row's centre decides the slot: past a sibling's midpoint, take its place.
    const centre = d.mids[d.from] + dy;
    let over = 0;
    for (let i = 0; i < d.mids.length; i++) if (i !== d.from && d.mids[i] < centre) over++;
    if (over !== d.over) {
      d.over = over;
      setActive({ from: d.from, over });
    }
  }, [scrollerRef]);

  const autoScroll = useCallback(() => {
    const d = drag.current;
    const scroller = scrollerRef?.current;
    if (!d || !scroller) return;
    const r = scroller.getBoundingClientRect();
    let v = 0;
    if (d.y < r.top + EDGE) v = -MAX_SCROLL * Math.min(1, (r.top + EDGE - d.y) / EDGE);
    else if (d.y > r.bottom - EDGE) v = MAX_SCROLL * Math.min(1, (d.y - (r.bottom - EDGE)) / EDGE);
    if (v) {
      scroller.scrollTop += v;
      place();
    }
    d.raf = requestAnimationFrame(autoScroll);
  }, [place, scrollerRef]);

  const finish = useCallback((commit: boolean) => {
    const d = drag.current;
    if (!d) return;
    cancelAnimationFrame(d.raf);
    drag.current = null;
    const el = rows.current[d.from];
    if (el) {
      el.style.transform = "";
      el.classList.remove(liftedClass);
    }
    setSettling(true);
    setActive(null);
    if (commit && d.over !== d.from) {
      onReorder(d.from, d.over);
      setAnnounce(t("Moved to position {{n}} of {{total}}", { n: d.over + 1, total: d.mids.length }));
    }
  }, [onReorder, t, liftedClass]);

  const onGripPointerDown = (index: number) => (e: PointerEvent<HTMLButtonElement>) => {
    if (!enabled || e.button !== 0 || drag.current || count < 2) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const mids = rows.current.slice(0, count).map((el) => el.offsetTop + el.offsetHeight / 2);
    drag.current = {
      from: index, over: index, pointerId: e.pointerId,
      startY: e.clientY, y: e.clientY, startScroll: scrollerRef?.current?.scrollTop ?? 0,
      mids, step: (rows.current[index]?.offsetHeight ?? 0) + rowGap, raf: 0,
    };
    rows.current[index]?.classList.add(liftedClass);
    setActive({ from: index, over: index });
    if (scrollerRef?.current) drag.current.raf = requestAnimationFrame(autoScroll);
  };
  const onGripPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    d.y = e.clientY;
    place();
  };
  const onGripPointerUp = (e: PointerEvent) => {
    if (drag.current && e.pointerId === drag.current.pointerId) finish(true);
  };
  const onGripKeyDown = (index: number) => (e: KeyboardEvent) => {
    if (e.key === "Escape" && drag.current) {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
      return;
    }
    if (drag.current) return;
    const to = e.key === "ArrowUp" ? index - 1 : e.key === "ArrowDown" ? index + 1 : null;
    if (to == null) return;
    e.preventDefault();
    if (to < 0 || to >= count) return;
    focusAfter.current = to;
    onReorder(index, to);
    setAnnounce(t("Moved to position {{n}} of {{total}}", { n: to + 1, total: count }));
  };

  // Escape cancels a pointer drag even when focus is elsewhere.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, finish]);

  // Where each sibling sits while a drag is live: one slot up or down.
  const shiftOf = (i: number) => {
    if (!active || i === active.from) return undefined;
    const step = drag.current?.step ?? 0;
    if (active.from < active.over && i > active.from && i <= active.over) return `translateY(${-step}px)`;
    if (active.over < active.from && i >= active.over && i < active.from) return `translateY(${step}px)`;
    return "translateY(0)";
  };

  useEffect(() => {
    if (!enabled) finish(false);
  }, [enabled, finish]);

  useEffect(() => () => {
    const d = drag.current;
    if (d) {
      cancelAnimationFrame(d.raf);
      rows.current[d.from]?.classList.remove(liftedClass);
      if (rows.current[d.from]) rows.current[d.from].style.transform = "";
      drag.current = null;
    }
  }, [liftedClass]);

  const gripProps = (index: number) => ({
    "data-sortable-grip": "",
    "aria-keyshortcuts": "ArrowUp ArrowDown",
    onPointerDown: onGripPointerDown(index),
    onPointerMove: onGripPointerMove,
    onPointerUp: onGripPointerUp,
    onPointerCancel: () => finish(false),
    onLostPointerCapture: () => finish(false),
    onKeyDown: onGripKeyDown(index),
  });
  return { rows, active, settling, announce, shiftOf, gripProps };
}
