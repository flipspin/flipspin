/** Keep device play counts per backend origin so server paths and counts cannot mix.
 * Server counts cover only saved songs; local counts also rank unsaved listening.
 * Return a stable snapshot between writes for useSyncExternalStore. */
import { useSyncExternalStore } from "react";
import { API_BASE_URL } from "./api";

export interface PlayEntry {
  /** times played */
  n: number;
  /** last play, epoch ms */
  at: number;
}
export type PlayHistory = Record<string, PlayEntry>;

/** Migrate the legacy history key shared by all servers. */
const LEGACY_KEY = "krobi.playHistory";
/** Enough for any top-N; the least recent entries go first past this. */
const MAX_ENTRIES = 500;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/** Same origin source as every API call (`API_BASE_URL` in utils/api.ts). */
export const playHistoryKey = (base: string = API_BASE_URL): string => `${LEGACY_KEY}:${originOf(base)}`;
const KEY = playHistoryKey();

const listeners = new Set<() => void>();

function parse(raw: string | null): PlayHistory | null {
  try {
    const value: unknown = JSON.parse(raw || "null");
    return value && typeof value === "object" ? (value as PlayHistory) : null;
  } catch {
    return null;
  }
}

function read(): PlayHistory {
  try {
    const own = parse(localStorage.getItem(KEY));
    if (own) return own;
    // One-time move: the unkeyed history belongs to whichever server this
    // install was talking to when it was written; the current one.
    const legacy = parse(localStorage.getItem(LEGACY_KEY));
    if (legacy) {
      localStorage.setItem(KEY, JSON.stringify(legacy));
      localStorage.removeItem(LEGACY_KEY);
      return legacy;
    }
  } catch {
    /* blocked storage */
  }
  return {};
}

let counts: PlayHistory = read();

export function recordLocalPlay(track: { path?: string | null } | null | undefined): void {
  const path = track?.path;
  if (!path) return;
  const was = counts[path];
  let next = { ...counts, [path]: { n: (was?.n || 0) + 1, at: Date.now() } };
  const keys = Object.keys(next);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => (next[a].at || 0) - (next[b].at || 0));
    next = Object.fromEntries(keys.slice(keys.length - MAX_ENTRIES).map((k) => [k, next[k]]));
  }
  counts = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(counts));
  } catch {
    /* blocked storage: the count lasts this session only */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = (): PlayHistory => counts;

/** `{ [path]: { n, at } }` */
export function usePlayHistory(): PlayHistory {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
