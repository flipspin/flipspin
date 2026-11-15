import { useEffect, useLayoutEffect, useSyncExternalStore, type RefObject } from "react";
import { bridge, hasBridge } from "../bridge";

export const HOME_RAIL_FOLDED_KEY = "krobi.homeRailFolded";
let preference: boolean | undefined;
let automatic = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
function preferredFold(): boolean {
  if (preference === undefined) {
    try { preference = localStorage.getItem(HOME_RAIL_FOLDED_KEY) === "1"; }
    catch { preference = false; }
  }
  return preference;
}
const snapshot = () => automatic || preferredFold();
function storageChanged(event: StorageEvent) {
  if (event.key !== HOME_RAIL_FOLDED_KEY && event.key !== null) return;
  preference = undefined;
  notify();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("storage", storageChanged);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) window.removeEventListener("storage", storageChanged);
  };
}

/** One preference for this computer, retained when Home unmounts. Read during
 * render so the first painted rail already has its remembered width. */
export function useHomeRailState(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
export function toggleHomeRail(): void {
  preference = !preferredFold();
  try { localStorage.setItem(HOME_RAIL_FOLDED_KEY, preference ? "1" : "0"); }
  catch { /* Keep the choice for this session if storage is unavailable. */ }
  notify();
}

export function useHomeRailShortcut(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    if (hasBridge()) {
      let active = true;
      const stop = bridge().on("view:command", (command) => {
        if (active && command === "toggle-side-column") toggleHomeRail();
      });
      // Native listener registration/cleanup is asynchronous; ignore late events.
      return () => { active = false; stop(); };
    }
    const onKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return;
      // Option changes KeyboardEvent.key on macOS; the physical code stays put.
      if (event.defaultPrevented || event.repeat || !event.metaKey || !event.altKey || event.ctrlKey || event.shiftKey) return;
      if (event.code !== "Backslash" && event.key !== "\\") return;
      event.preventDefault();
      toggleHomeRail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

/** Observe the available shell width, so folding the left sidebar counts too.
 * The automatic constraint never writes the user's preference. */
export function useHomeRailLayout(rootRef: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const folded = useHomeRailState();
  useLayoutEffect(() => {
    const root = rootRef.current;
    const shell = root?.closest<HTMLElement>(".shell-frame") ?? root?.closest<HTMLElement>(".home-columns");
    const rail = shell?.querySelector<HTMLElement>(".home-rail");
    if (!enabled || !shell || !rail) return;
    let frame = 0;
    let width: number | undefined;
    const measure = () => {
      const next = shell.getBoundingClientRect().width;
      if (next === width || next <= 0) return;
      width = next;
      // Freeze motion for the whole resize delivery, including widening.
      rail.setAttribute("data-resizing", "");
      automatic = next - 320 < 640;
      rail.toggleAttribute("data-folded", snapshot());
      notify();
      // Commit the new width with transitions disabled before re-enabling them.
      void rail.offsetWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => rail.removeAttribute("data-resizing"));
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(shell);
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      rail.removeAttribute("data-resizing");
      automatic = false;
      notify();
    };
  }, [enabled, rootRef]);
  return folded;
}
