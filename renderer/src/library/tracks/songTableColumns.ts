/** Keep column choices outside React so navigation preserves them.
 * Hide matching header and row cells through CSS to keep their columns aligned.
 * Return the same snapshot object until a write for useSyncExternalStore. */

import { createContext, useMemo, useSyncExternalStore, type CSSProperties } from "react";
import { msg } from "../../i18n";
import { genreLabel } from "../../albums/genreLabel";
import { lyricsKeyOf } from "../../lyrics/lyricsStore";
import { analysisDisplay } from "../../analysis/display";
import type { ListedTrack } from "../../home/decorateTrack";
import type { LyricState } from "../../lyrics/lyricStates";

export type SongColumnId = "artist" | "album" | "genre" | "date" | "analysis" | "key" | "bpm" | "lyrics" | "duration";
export type SongWidthId = "title" | SongColumnId;
export type SongColumnWidths = Partial<Record<SongWidthId, number>>;
export const SONG_WIDTH_IDS: readonly SongColumnId[] = ["artist", "album", "genre", "date", "analysis", "key", "bpm", "lyrics", "duration"];

export function songColumnMin(id: SongWidthId): number {
  return id === "title" ? 160 : id === "analysis" || id === "bpm" ? 40 : 48;
}

export function clampSongColumnWidth(id: SongWidthId, width: number): number {
  return Math.min(600, Math.max(songColumnMin(id), width));
}

export function normalizeSongColumnWidths(value: unknown): SongColumnWidths {
  const widths: SongColumnWidths = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return widths;
  // Title always takes the remaining space; discard widths from older saves.
  for (const id of SONG_WIDTH_IDS) {
    const width = value[id];
    if (typeof width === "number" && Number.isFinite(width)) widths[id] = clampSongColumnWidth(id, width);
  }
  return widths;
}
export type SongTableKind = "library" | "playlist";

export interface SongColumn {
  id: SongColumnId;
  /** A `msg()` key; the render site translates it with `t(column.label)`. */
  label: string;
  /** What the picker says under the label. A `msg()` key, like `label`. */
  hint: string;
}

/** Every column a user may switch off. "#" and "Title" are the row's identity and never listed. */
export const SONG_COLUMNS: readonly SongColumn[] = [
  { id: "artist", label: msg("Artist"), hint: msg("Who plays it") },
  { id: "album", label: msg("Album"), hint: msg("Which record") },
  { id: "genre", label: msg("Genre"), hint: msg("Style of music") },
  { id: "date", label: msg("Date"), hint: msg("When it reached the library") },
  { id: "analysis", label: msg("Info"), hint: msg("The song's info card") },
  { id: "key", label: msg("Key_tone"), hint: msg("Detected key") },
  { id: "bpm", label: msg("BPM"), hint: msg("Detected tempo") },
  { id: "lyrics", label: msg("Lyrics"), hint: msg("Lyrics status") },
  { id: "duration", label: msg("Duration"), hint: msg("Minutes and seconds") },
];

const AUTO_COLUMNS: readonly SongColumnId[] = ["genre", "date", "analysis", "key", "bpm", "lyrics"];
const NO_EMPTY_COLUMNS: readonly SongColumnId[] = [];

/** List-local availability, shared with pickers nested inside the header. Never persisted. */
export const EmptySongColumnsContext = createContext(NO_EMPTY_COLUMNS);

export function emptySongColumns(items: readonly ListedTrack[], lyricStates?: Readonly<Record<string, LyricState>>): readonly SongColumnId[] {
  const filled = new Set<SongColumnId>();
  for (const track of items) {
    if (genreLabel(track.genre as string | string[] | null, "es")) filled.add("genre");
    const metadata = track.metadata as { dateAdded?: unknown } | null | undefined;
    if (track.dateAdded ?? metadata?.dateAdded) filled.add("date");
    if (track.analysis || track.mood || track.bpm) filled.add("analysis");
    if (!analysisDisplay({ key: track.key }, "key").missing) filled.add("key");
    if (track.bpm != null && track.bpm !== "") filled.add("bpm");
    const lyricState = lyricStates?.[lyricsKeyOf(track) || ""];
    if (lyricState === "plain" || lyricState === "synced") filled.add("lyrics");
    if (filled.size === AUTO_COLUMNS.length) break;
  }
  return AUTO_COLUMNS.filter(id => !filled.has(id));
}

/** Scan the current list, never the virtual window or individual row renders.
 * A lyric-index update is also a data change: newly fetched words can fill Lyrics.
 */
export function useEmptySongColumns(items: readonly ListedTrack[], lyricStates?: Readonly<Record<string, LyricState>>): readonly SongColumnId[] {
  return useMemo(() => emptySongColumns(items, lyricStates), [items, lyricStates]);
}

const STORAGE_KEY = "krobi.songTable.hiddenColumns";
const ORDER_KEY = "krobi.songTable.columnOrder";
const WIDTHS_KEY = "krobi.songTable.columnWidths";
const DEFAULT_ORDER = SONG_COLUMNS.map(column => column.id);
const COVERS_KEY = "krobi.songTable.covers";
export const DEFAULT_COVERS: Readonly<Record<SongTableKind, boolean>> = { library: false, playlist: true };
const KNOWN = new Set<string>(SONG_COLUMNS.map((c) => c.id));

export interface SongTableColumnsState {
  /** Hidden column ids, in `SONG_COLUMNS` order. Everything else is visible. */
  hidden: readonly SongColumnId[];
  order: SongColumnId[];
  widths: SongColumnWidths;
  covers: Readonly<Record<SongTableKind, boolean>>;
}

function normalize(ids: Iterable<unknown>): SongColumnId[] {
  const wanted = new Set<string>();
  for (const id of ids) if (typeof id === "string" && KNOWN.has(id)) wanted.add(id);
  // Canonical order, so two states with the same members are equal as strings.
  return SONG_COLUMNS.filter((c) => wanted.has(c.id)).map((c) => c.id);
}

/** Preserve the user's order, discard obsolete ids/duplicates, append new columns. */
function normalizeOrder(ids: unknown[]): SongColumnId[] {
  return [...new Set([...ids.filter((id): id is SongColumnId => typeof id === "string" && KNOWN.has(id)), ...DEFAULT_ORDER])];
}

function load(): SongTableColumnsState {
  let hidden: SongColumnId[] = [];
  const covers = { ...DEFAULT_COVERS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    hidden = Array.isArray(parsed) ? normalize(parsed) : [];
  } catch {
    // Invalid column storage must not discard the independent cover choice.
  }
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COVERS_KEY) ?? "null");
    if (parsed && typeof parsed === "object") {
      for (const kind of ["library", "playlist"] as const) {
        if (typeof parsed[kind] === "boolean") covers[kind] = parsed[kind];
      }
    }
  } catch {
    // Missing storage or an older/invalid value uses the per-table defaults.
  }
  let order = [...DEFAULT_ORDER];
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "null");
    if (Array.isArray(parsed)) order = normalizeOrder(parsed);
  } catch {
    // Order and visibility are independent preferences, including corrupt storage.
  }
  let widths: SongColumnWidths = {};
  try {
    widths = normalizeSongColumnWidths(JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "null"));
  } catch {
    // Widths are independent of the other device preferences.
  }
  return { hidden, covers, order, widths };
}

let state: SongTableColumnsState = load();
const listeners = new Set<() => void>();

function set(hidden: SongColumnId[]): void {
  if (hidden.join(",") === state.hidden.join(",")) return;
  state = { ...state, hidden };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(hidden));
  } catch {
    // Private mode or a full quota: the choice lives for the session only.
  }
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getState(): SongTableColumnsState {
  return state;
}

export function isColumnVisible(id: SongColumnId): boolean {
  return !state.hidden.includes(id);
}

export function toggleColumn(id: SongColumnId): void {
  const next = new Set<string>(state.hidden);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  set(normalize(next));
}

export function setColumnVisible(id: SongColumnId, visible: boolean): void {
  const next = new Set<string>(state.hidden);
  if (visible) next.delete(id);
  else next.add(id);
  set(normalize(next));
}

/** Back to every column on. */
export function resetColumns(): void {
  set([]);
}

export function setColumnOrder(ids: SongColumnId[]): void {
  const order = normalizeOrder(ids);
  if (order.join(",") === state.order.join(",")) return;
  state = { ...state, order };
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    // Keep the session choice when storage is unavailable.
  }
  listeners.forEach(listener => listener());
}

/** Commit once at the end of an interaction; live moves only touch the DOM. */
export function setColumnWidths(value: SongColumnWidths): void {
  const widths = normalizeSongColumnWidths(value);
  if (JSON.stringify(widths) === JSON.stringify(state.widths)) return;
  state = { ...state, widths };
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths));
  } catch {
    // Keep the session choice when storage is unavailable.
  }
  listeners.forEach(listener => listener());
}

export function resetColumnWidths(): void {
  setColumnWidths({});
}

/** Applied on each grid, where --sc-* widths resolve after visibility/container
 * rules. Putting this on an ancestor resolves var() too early, before those
 * local widths exist. Header, regular rows and missing rows share this helper.
 */
export function songTableGridStyle(order: readonly SongColumnId[]): CSSProperties {
  return { "--sc-template": ["num", "cover", "title", ...order, "end"]
    .map(id => `[${id}] var(--sc-${id})`).join(" ") } as CSSProperties;
}

export function useSongTableGridStyle(): CSSProperties {
  const { order } = useSongTableColumns();
  return useMemo(() => songTableGridStyle(order), [order]);
}

export function setCoversVisible(kind: SongTableKind, visible: boolean): void {
  if (state.covers[kind] === visible) return;
  const covers = { ...state.covers, [kind]: visible };
  state = { ...state, covers };
  try {
    localStorage.setItem(COVERS_KEY, JSON.stringify(covers));
  } catch {
    // The choice still lives for this session when storage is unavailable.
  }
  listeners.forEach((l) => l());
}

/** The class list for the table root: one `song-table--hide-<id>` per hidden column. */
export function songTableRootClass(s: { hidden: readonly SongColumnId[]; covers?: SongTableColumnsState["covers"] } = state, lyricsFiltered = false, kind: SongTableKind = "library", emptyColumns: readonly SongColumnId[] = NO_EMPTY_COLUMNS): string {
  const hidden = new Set([...s.hidden, ...emptyColumns]);
  return [...hidden].map((id) => `song-table--hide-${id}`).concat(
    (s.covers?.[kind] ?? DEFAULT_COVERS[kind]) ? ["song-table--covers"] : [],
    lyricsFiltered ? ["song-table--lyrics"] : [],
  ).join(" ");
}

/** For tests: what a fresh process would read from localStorage. */
export function _reloadFromStorageForTest(): void {
  state = load();
  listeners.forEach((l) => l());
}

/** For tests: forget everything, including what localStorage held. */
export function _resetForTest(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(COVERS_KEY);
    localStorage.removeItem(ORDER_KEY);
    localStorage.removeItem(WIDTHS_KEY);
  } catch {
    // ignore
  }
  state = { hidden: [], covers: { ...DEFAULT_COVERS }, order: [...DEFAULT_ORDER], widths: {} };
  listeners.forEach((l) => l());
}

export function useSongTableColumns(): SongTableColumnsState {
  return useSyncExternalStore(subscribe, getState, getState);
}
