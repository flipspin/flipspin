import { useSyncExternalStore } from "react";

type ViewMode = "list" | "grid";
const KEY = "krobi.playlists.view";
const listeners = new Set<() => void>();

function load(): ViewMode {
  try { return localStorage.getItem(KEY) === "grid" ? "grid" : "list"; }
  catch { return "list"; }
}
let mode = load();

export function setPlaylistViewMode(next: ViewMode) {
  if (mode === next) return;
  mode = next;
  try { localStorage.setItem(KEY, next); } catch { /* Keep the session choice. */ }
  listeners.forEach(listener => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function usePlaylistViewMode() {
  return useSyncExternalStore(subscribe, () => mode, () => mode);
}
