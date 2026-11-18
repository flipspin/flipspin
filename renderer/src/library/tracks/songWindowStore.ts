import { useSyncExternalStore } from "react";

/** Keep track-info state outside the list so opening details does not rerender every song row. */
export type SongTrack = import("../../analysis/display").AnalysisTrack & { path: string; relPath?: string; title?: string; artist?: string; album?: string | { album?: string; artist?: string; year?: string | number; cover?: string }; [key: string]: unknown };
let current: SongTrack | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function openSongWindow(track: SongTrack | null) {
  current = track ?? null;
  emit();
}
export function closeSongWindow() {
  current = null;
  emit();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function useSongWindowTrack() {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

// One host draws the panel even if two surfaces that mount one are alive.
let hostSeq = 0;
const hosts: number[] = [];
export function claimHost(): number {
  const id = ++hostSeq;
  hosts.push(id);
  emit();
  return id;
}
export function releaseHost(id: number) {
  const i = hosts.indexOf(id);
  if (i >= 0) hosts.splice(i, 1);
  emit();
}
export function useIsActiveHost(id: number | null) {
  return useSyncExternalStore(subscribe, () => id != null && hosts[0] === id, () => false);
}
