import { poll } from '../data/poll'
import { watchChanges } from '../data/changeListeners'
import { useSyncExternalStore } from "react";
import { optionalBridge, type ApiData } from "../data";
import { lyricsIndexChanged, lyricsKeyOf } from "./lyricsStore";
import { isOfflineNow } from "../offline/policy";
import { getApiClient } from "../data/backend";
import { msg } from "../i18n";

export type LyricStates = ApiData<"/api/lyrics/states", "get">;
export type LyricState = LyricStates["states"][string];
export const LYRIC_LABELS = {
  synced: msg("Synced"), plain: msg("Text"), pending: msg("No lyrics"),
  none: msg("Not searched_unsearched"), instrumental: msg("Instrumental"), queued: msg("Queued"),
};
export const LYRIC_FILTERS = [
  { value: "all", label: msg("All") },
  { value: "with", label: msg("With lyrics") },
  { value: "without", label: msg("No lyrics") },
];
type ViewStates = LyricStates & {
  /** Keep a song in its last known category while a job overlays it with queued. */
  filterStates: LyricStates["states"];
  filterCounts: LyricStates["counts"];
};
const emptyCounts = (): LyricStates["counts"] => ({ synced: 0, plain: 0, pending: 0, none: 0, instrumental: 0, queued: 0 });
const empty = (): ViewStates => ({ states: {}, counts: emptyCounts(), filterStates: {}, filterCounts: emptyCounts() });
let snapshot = empty();
let etag: string | null = null;
let generation = 0;
let removeIdentityListener: (() => void) | undefined;
const listeners = new Set<() => void>();
let running: Promise<void> | null = null;
let stopPoll: (() => void) | undefined;
export async function refreshLyricStates() {
  // No view needs this map off-library; keeping it would outlive its scope listener.
  if (!listeners.size || isOfflineNow() || poll('idle') === false) return;
  const current = generation;
  running ??= getApiClient().then((client) => client.GET("/api/lyrics/states", { headers: etag ? { "If-None-Match": etag } : {} })).then(({ data, response }) => {
    if (current !== generation || response.status === 304) return;
    if (!response.ok || !data) throw new Error(`Letra: ${response.status}`);
    etag = response.headers.get("ETag");
    const completed = Object.keys(data.states).filter(path => snapshot.states[path] === "queued" && data.states[path] !== "queued");
    lyricsIndexChanged(etag ?? JSON.stringify(data.states), completed);
    const filterStates = { ...data.states };
    const filterCounts = { ...data.counts };
    for (const [rel, value] of Object.entries(data.states)) {
      const previous = snapshot.filterStates[rel];
      if (value === "queued" && previous && previous !== "queued") {
        filterStates[rel] = previous;
        filterCounts.queued -= 1;
        filterCounts[previous] += 1;
      }
    }
    snapshot = { ...data, filterStates, filterCounts };
    listeners.forEach((fn) => fn());
  }).finally(() => { if (current === generation) running = null; });
  return running;
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  if (listeners.size === 1) {
    removeIdentityListener = optionalBridge()?.on("auth:changed", () => {
      generation++; etag = null; running = null; snapshot = empty();
      listeners.forEach((fn) => fn());
      void refreshLyricStates().catch(() => {});
    });
    stopPoll = watchChanges(['lyrics', 'library', 'jobs', 'me:<account>'], () => refreshLyricStates().catch(() => {}));
  }
  return () => { listeners.delete(fn); if (!listeners.size) { stopPoll?.(); stopPoll = undefined; removeIdentityListener?.(); removeIdentityListener = undefined; generation++; etag = null; running = null; snapshot = empty(); } };
}
export function useLyricStates() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
export function lyricStateFor(track: Parameters<typeof lyricsKeyOf>[0], data = snapshot): LyricState {
  return data.states[lyricsKeyOf(track) || ""] || "none";
}
export function lyricFilterStateFor(track: Parameters<typeof lyricsKeyOf>[0], data = snapshot): LyricState | null {
  const key = lyricsKeyOf(track);
  // Missing index entries and a first-seen queued job cannot establish whether
  // words exist. Never turn an unresolved song into a known absence.
  const state = key ? data.filterStates[key] : undefined;
  return state && state !== "queued" ? state : null;
}
export function matchesLyricFilter(state: LyricState | null, filter: string) {
  if (filter === "all") return true;
  if (!state || state === "queued") return false;
  const hasLyrics = state === "synced" || state === "plain";
  return filter === "with" ? hasLyrics : filter === "without" && !hasLyrics;
}
export function lyricFilterCounts(tracks: Parameters<typeof lyricsKeyOf>[0][], data = snapshot) {
  let withLyrics = 0;
  let withoutLyrics = 0;
  let unknown = false;
  for (const track of tracks) {
    const state = lyricFilterStateFor(track, data);
    if (state === null) unknown = true;
    else if (matchesLyricFilter(state, "with")) withLyrics++;
    else withoutLyrics++;
  }
  return { all: tracks.length, with: unknown ? "…" : withLyrics, without: unknown ? "…" : withoutLyrics };
}

/** One index read per pin reconciliation, never one speculative GET per song. */
export async function offlineLyricStates(signal: AbortSignal) {
  const client = await getApiClient();
  const { data, response } = await client.GET("/api/lyrics/states", { signal, fetch: optionalBridge()?.fetch });
  if (!response.ok || !data) throw new Error(`Lyrics index: ${response.status}`);
  return data.states;
}
