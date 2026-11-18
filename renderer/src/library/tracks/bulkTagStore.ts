import { useSyncExternalStore } from "react";
import { relPathOf } from "@state/userLibraryStore";

export type TagSong = { path?: string | null; relPath?: string | null };
let paths: string[] | null = null;
let detail: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function bulkTagPaths(songs: TagSong[]) {
  return [...new Set(songs.map(relPathOf).filter((path): path is string => !!path))];
}
export function openBulkTags(songs: TagSong[]) {
  const next = bulkTagPaths(songs);
  if (next.length < 1 || next.length > 500 || songs.some(song => !relPathOf(song))) return;
  paths = next;
  emit();
}
export function closeBulkTags() { paths = null; emit(); }
export function openTagEditDetails(editId: string) { detail = editId; emit(); }
export function closeTagEditDetails() { detail = null; emit(); }
export const useBulkTagPaths = () => useSyncExternalStore(subscribe, () => paths, () => null);
export const useTagEditDetails = () => useSyncExternalStore(subscribe, () => detail, () => null);
