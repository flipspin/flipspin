/** The persistent header shares its already prepared, account-filtered local index.
 * Explore registers its loader here so the shell needs no App prop plumbing. */
import { useSyncExternalStore } from "react";
import { librarySearchIndex } from "./librarySearch";

const emptyIndex = librarySearchIndex([], []);
let index = emptyIndex;
let refresh: { loading: boolean; when: string | null; run: () => void } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function registerSearchIndex(next: typeof index) {
  index = next; emit();
  return () => { if (index === next) { index = emptyIndex; emit(); } };
}
export function useTopSearchIndex() { return useSyncExternalStore(subscribe, () => index); }
export function registerExploreRefresh(next: NonNullable<typeof refresh>) {
  refresh = next; emit();
  return () => { if (refresh === next) { refresh = null; emit(); } };
}
export function useExploreRefresh() { return useSyncExternalStore(subscribe, () => refresh); }
