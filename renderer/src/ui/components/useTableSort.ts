import type { SchemaTrackWithMetadata } from "../../api/generated/schema";
import type { PlayerAlbum } from "../../state/playerQueue";
import { useState, useEffect } from "react";
import { keyCode } from "../../analysis/keys";
import { camelotIndex } from "@lib/camelot";

// How each sortable column reads a value off a track row. String accessors are
// compared with localeCompare; numeric ones numerically (missing -> sorts last).
type SortTrack = Partial<Pick<SchemaTrackWithMetadata, "title" | "artist" | "genre" | "key" | "bpm" | "duration" | "track_number">> & {
  dateAdded?: number | string | null;
  album?: string | PlayerAlbum | null;
  metadata?: (Partial<Pick<SchemaTrackWithMetadata, "duration" | "track_number">> & { dateAdded?: number | string | null }) | null;
};
const ACCESSORS = {
  title: (t: SortTrack) => (t.title || "").toString().toLowerCase(),
  artist: (t: SortTrack) => (t.artist || (typeof t.album === "object" ? t.album?.artist : "") || "").toString().toLowerCase(),
  album: (t: SortTrack) => {
    const a = t.album;
    return (a && typeof a === "object" ? (a.album || a.name || "") : (a || "")).toString().toLowerCase();
  },
  // No genre sorts last, like a missing BPM.
  genre: (t: SortTrack) => (t.genre ? String(t.genre).toLowerCase() : Infinity),
  date: (t: SortTrack) => Number(t.dateAdded ?? t.metadata?.dateAdded ?? 0),
  key: (t: SortTrack) => camelotIndex(keyCode(typeof t.key === "string" ? t.key : "")),
  bpm: (t: SortTrack) => {
    const n = Number(t.bpm);
    return Number.isFinite(n) && n > 0 ? n : Infinity;
  },
  duration: (t: SortTrack) => Number(t.duration ?? t.metadata?.duration ?? 0),
  track: (t: SortTrack) => {
    const n = Number(t.track_number ?? t.metadata?.track_number);
    return Number.isFinite(n) && n > 0 ? n : Infinity;
  },
};

// Apply tie-breakers ascending so albums retain track order and artists retain album groups.
type SortField = keyof typeof ACCESSORS;
const TIE_BREAKS: Partial<Record<SortField, SortField[]>> = {
  artist: ["album", "track"],
  album: ["artist", "track"],
};

function compareBy(field: SortField, a: SortTrack, b: SortTrack) {
  const acc = ACCESSORS[field];
  const va = acc(a);
  const vb = acc(b);
  if (typeof va === "string" || typeof vb === "string") return String(va).localeCompare(String(vb));
  if (va === vb) return 0;
  return va < vb ? -1 : 1;
}

/** Return a new array sorted by `field`/`dir`; the input order when no field. */
export function sortTracks<T extends SortTrack[]>(tracks: T, field: string | null, dir: string): T {
  if (!field || !Object.hasOwn(ACCESSORS, field)) return tracks;
  const key = field as SortField;
  const mul = dir === "desc" ? -1 : 1;
  const ties = TIE_BREAKS[key] || [];
  return [...tracks].sort((a, b) => {
    // Missing values (Infinity: no BPM analysed yet) stay last both ways.
    const va = ACCESSORS[key](a);
    const vb = ACCESSORS[key](b);
    if (va === Infinity || vb === Infinity) {
      if (va !== vb) return va === Infinity ? 1 : -1;
    }
    const main = compareBy(key, a, b) * mul;
    if (main) return main;
    for (const f of ties) {
      const c = compareBy(f, a, b);
      if (c) return c;
    }
    return 0;
  }) as T;
}

/**
 * Sort state + a toggle that flips direction when re-clicking the same column.
 * With `resetOnOutsideClick`, an active sort is cleared (reverting to the list's
 * own/custom order) on any mousedown outside a `[data-sort-header]` cell.
 */
export function useTableSort({ resetOnOutsideClick = false }: { resetOnOutsideClick?: boolean } = {}) {
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const toggleSort = (field: string) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  };
  const clearSort = () => setSortField(null);

  useEffect(() => {
    if (!resetOnOutsideClick || !sortField) return;
    const onDown = (e: MouseEvent) => {
      // Opening a row menu must preserve the current column sort.
      if (e.button !== 0) return;
      if (e.target instanceof Element && e.target.closest("[data-sort-header]")) return;
      setSortField(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [resetOnOutsideClick, sortField]);

  return { sortField, sortDir, toggleSort, clearSort };
}
