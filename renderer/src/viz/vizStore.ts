/**
 * Whether the full-screen visualizer is open. A module singleton like
 * `lyricsStore`: the button lives in the transport bar and the overlay mounts
 * beside the app shell, and the state has to survive a page change because
 * the song keeps playing.
 */
import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function set(next: boolean) {
  if (open === next) return;
  open = next;
  listeners.forEach((fn) => fn());
}

export const openViz = () => set(true);
export const closeViz = () => set(false);
export const toggleViz = () => set(!open);

export function useVizOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open, () => false);
}
