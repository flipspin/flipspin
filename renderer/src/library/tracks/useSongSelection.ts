import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Song = { path: string };
type Mods = { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean };

/** Keep selection within visible rows so filtering cannot leave hidden songs in an action.
 * Shift ranges replace the previous range so selection can shrink as well as grow. */
export function useSongSelection<T extends Song>(visible: T[]) {
  const [paths, setPaths] = useState<Set<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const cursor = useRef<string | null>(null);


  useEffect(() => {
    setPaths((prev) => {
      if (prev.size === 0) return prev;
      const shown = new Set(visible.map((s) => s.path));
      const next = new Set([...prev].filter((p) => shown.has(p)));
      return next.size === prev.size ? prev : next;
    });
  }, [visible]);

  const selected = useMemo(() => visible.filter((s) => paths.has(s.path)), [visible, paths]);
  const isSelected = useCallback((s: Song) => paths.has(s.path), [paths]);

  const indexOf = useCallback((path: string | null) => (path ? visible.findIndex((s) => s.path === path) : -1), [visible]);

  const range = useCallback(
    (from: string | null, to: string) => {
      const a = indexOf(from);
      const b = indexOf(to);
      if (a < 0 || b < 0) return new Set([to]);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return new Set(visible.slice(lo, hi + 1).map((s) => s.path));
    },
    [visible, indexOf],
  );

  const click = useCallback(
    (song: Song, e: Mods = {}) => {
      if (e.shiftKey && anchor.current) {
        setPaths(range(anchor.current, song.path));
      } else if (e.metaKey || e.ctrlKey) {
        setPaths((prev) => {
          const next = new Set(prev);
          if (next.has(song.path)) next.delete(song.path);
          else next.add(song.path);
          return next;
        });
        anchor.current = song.path;
      } else {
        setPaths(new Set([song.path]));
        anchor.current = song.path;
      }
      cursor.current = song.path;
    },
    [range],
  );

  /** Right-click: keep a selection the row belongs to, else select just it. */
  const forRow = useCallback(
    (song: T): T[] => {
      if (paths.has(song.path) && selected.length > 1) return selected;
      setPaths(new Set([song.path]));
      anchor.current = song.path;
      cursor.current = song.path;
      return [song];
    },
    [paths, selected],
  );

  const selectAll = useCallback(() => {
    setPaths(new Set(visible.map((s) => s.path)));
    anchor.current = visible[0]?.path ?? null;
  }, [visible]);
  const clear = useCallback(() => {
    setPaths((prev) => (prev.size ? new Set() : prev));
    anchor.current = null;
  }, []);

  /** Keyboard, for the element that holds the rows. Returns the path to reveal. */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent): string | null => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, [contenteditable='true']")) return null;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        selectAll();
        return null;
      }
      if (e.key === "Escape") {
        if (paths.size) {
          e.preventDefault();
          clear();
        }
        return null;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!visible.length) return null;
        e.preventDefault();
        const at = indexOf(cursor.current);
        const step = e.key === "ArrowDown" ? 1 : -1;
        const nextIdx = at < 0 ? (step > 0 ? 0 : visible.length - 1) : Math.max(0, Math.min(visible.length - 1, at + step));
        const song = visible[nextIdx];
        if (e.shiftKey && anchor.current) setPaths(range(anchor.current, song.path));
        else {
          setPaths(new Set([song.path]));
          anchor.current = song.path;
        }
        cursor.current = song.path;
        return song.path;
      }
      return null;
    },
    [paths, visible, indexOf, range, selectAll, clear],
  );

  return { selected, count: selected.length, isSelected, click, forRow, selectAll, clear, onKeyDown };
}
