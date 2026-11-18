import { poll } from '../data/poll'
import i18n from "../i18n";
/** Keep account ownership outside React so Browse and Library share it across navigation.
 * Index by relPath for per-row lookups and keep snapshots stable between mutations. */
import type { ApiData } from "../data/http";
import type { SchemaPlayRequest } from "../api/generated/schema";
import type { TrackLocator } from "../lib/api";

// Omit the defaulted completion flag, preserving the legacy request body.
type PlayBody = Omit<SchemaPlayRequest, "completed"> & Partial<Pick<SchemaPlayRequest, "completed">>;
type LibraryData = ApiData<"/api/me/library", "get">;
export type UserLibraryRow = LibraryData["tracks"][number];
// Optimistic rows have no server-assigned timestamp yet.
export type LibraryViewRow = Omit<UserLibraryRow, "addedAt"> & Partial<Pick<UserLibraryRow, "addedAt">>;
export interface UserLibraryState {
  capability: "unknown" | "no-user" | "ready";
  status: "idle" | "loading" | "ready" | "error";
  byRelPath: Record<string, LibraryViewRow>;
  count: number;
  removedRelPaths: Set<string>;
  error: string;
}

import { useSyncExternalStore } from "react";
import { onlineManager } from "@tanstack/react-query";
import { getForcedOffline } from "../offline/mode";
import { bridge, hasBridge } from "../bridge";
import { apiUrl, backendRequest, relPathForTrack } from "../lib/api";
import { getLibraryRoot, setLibraryRoot } from "../lib/libraryKeys";
import { subscribeToken } from "../lib/authToken";
import { isRealUser, getState as identityState, subscribe as subscribeIdentity } from "./identityStore";

const listeners = new Set<() => void>();
let baseDir: string | null = null;
let baseDirPromise: Promise<string | null> | null = null;
let revision = 0;
let etag: string | null = null;
let serverRows: Record<string, LibraryViewRow> = {};
let inFlight: Promise<void> | null = null;
let requestAbort: AbortController | null = null;
const changes = new Map<symbol, { keys: readonly string[]; method: string }>();
// Keep a just-removed missing row hidden until the missing query catches up.
const localRemovals = new Set<string>();

function publishRows() {
  let rows = { ...serverRows };
  let removedRelPaths = new Set(localRemovals);
  for (const change of changes.values()) {
    for (const key of change.keys) {
      if (change.method === 'DELETE') { delete rows[key]; removedRelPaths.add(key); }
      else { rows[key] ??= { relPath: key, liked: false, offline: false, playCount: 0 }; removedRelPaths.delete(key); }
    }
  }
  if (JSON.stringify(rows) === JSON.stringify(state.byRelPath)) rows = state.byRelPath;
  if (removedRelPaths.size === state.removedRelPaths.size && [...removedRelPaths].every(key => state.removedRelPaths.has(key))) removedRelPaths = state.removedRelPaths;
  set({ byRelPath: rows, count: Object.keys(rows).length, removedRelPaths });
}

/** A pending intent overlays refreshes; rollback affects only this transaction. */
export function optimisticLibrary(keys: readonly string[], method: string) {
  const token = Symbol();
  const person = identityState().me?.id;
  changes.set(token, { keys, method });
  publishRows();
  return (commit = false) => {
    if (person !== identityState().me?.id || !changes.has(token)) return;
    if (commit) for (const key of keys) {
      if (method === 'DELETE') { delete serverRows[key]; localRemovals.add(key); }
      else { serverRows[key] ??= { relPath: key, liked: false, offline: false, playCount: 0 }; localRemovals.delete(key); }
    }
    changes.delete(token);
    publishRows();
  };
}

/** Only token-backed accounts can own personal rows. A synthetic owner
 * gets one no-user state on 409 instead of repeated failures for every track. */
let state: UserLibraryState = { capability: "unknown", status: "idle", byRelPath: {}, count: 0, removedRelPaths: new Set(), error: "" };

function set(patch: Partial<UserLibraryState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function getState() {
  return state;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (state.status === "idle") load();
  return () => listeners.delete(listener);
}

function index(rows: LibraryData["tracks"] | null | undefined) {
  const byRelPath: Record<string, LibraryViewRow> = {};
  for (const row of rows || []) {
    if (row?.relPath) byRelPath[row.relPath] = row;
  }
  return byRelPath;
}

/**
 * The library root, so an absolute track path can be reduced to a `relPath`.
 *
 * Asked for here rather than taken from `LibraryContext`: this store is read by
 * code that is not a component, and coupling it to a provider would put it back
 * inside the tree that `App.jsx` unmounts.
 */
async function ensureBaseDir() {
  if (baseDir) return baseDir;
  if (!baseDirPromise) {
    const version = revision;
    baseDirPromise = fetch(apiUrl("/api/get-basedir")!)
      .then((r): Promise<ApiData<"/api/get-basedir", "get">> => r.json())
      .then((d) => {
        if (version !== revision) return null;
        // This route has no response model; narrow its directory field.
        baseDir = d && typeof d === "object" && "basedir" in d && typeof d.basedir === "string" ? d.basedir || null : null;
        if (baseDir && !getLibraryRoot()) setLibraryRoot(baseDir);
        return baseDir;
      })
      .catch(() => null)
      .finally(() => {
        if (version === revision) baseDirPromise = null;
      });
  }
  return baseDirPromise;
}

/**
 * Accepts either a library track (absolute `path`, needs reducing) or an API
 * row (`relPath`, already the identity). Keeping both forms here makes account
 * ownership checks use the same key everywhere.
 */
export function relPathOf(trackOrRow: TrackLocator | string | null | undefined) {
  if (trackOrRow && typeof trackOrRow === "object" && typeof trackOrRow.relPath === "string") {
    return trackOrRow.relPath;
  }
  return relPathForTrack(trackOrRow, baseDir);
}

export function load(): Promise<void> {
  if (poll('idle') === false || getForcedOffline() || !onlineManager.isOnline()) return Promise.resolve();
  if (inFlight) return inFlight;
  const version = revision;
  const pending = (async () => {
    if (!isRealUser(identityState())) {
      set({ capability: identityState().status === "ready" ? "no-user" : "unknown", status: "idle" });
      return;
    }
    if (state.status !== "ready") set({ status: "loading", error: "" });
    await ensureBaseDir();
    if (version !== revision || getForcedOffline() || poll('idle') === false) return;
    try {
      const controller = new AbortController();
      requestAbort = controller;
      const response = await backendRequest("/api/me/library", { signal: controller.signal, headers: etag ? { 'If-None-Match': etag } : {} });
      if (version !== revision) return;
      if (response.status === 304) {
        if (state.status !== "ready") set({ capability: "ready", status: "ready", error: "" });
        return;
      }
      if (response.status === 409) {
        serverRows = {}; changes.clear(); localRemovals.clear(); etag = null;
        set({ capability: "no-user", status: "idle", byRelPath: {}, count: 0, removedRelPaths: new Set() });
        return;
      }
      const data: LibraryData | null = response.body ? JSON.parse(response.body) : null;
      if (!response.ok || !data) throw new Error(i18n.t("Couldn't load your library."));
      etag = response.headers.etag || response.headers.ETag || null;
      serverRows = index(data.tracks);
      for (const key of localRemovals) if (serverRows[key]) localRemovals.delete(key);
      publishRows();
      set({ capability: "ready", status: "ready", error: "" });
    } catch (error) {
      if (version === revision) set({ status: "error", error: String(error && typeof error === "object" && "message" in error ? error.message || error : error) });
    }
  })();
  inFlight = pending;
  void pending.finally(() => { if (inFlight === pending) inFlight = null; });
  return pending;
}

/** A response begun before a write cannot overwrite the write's local result. */
export function libraryWriteSettled() {
  revision++;
  requestAbort?.abort(); requestAbort = null;
  etag = null;
  inFlight = null;
  if (!baseDir) baseDirPromise = null;
}

export function resetLibrary() {
  requestAbort?.abort(); requestAbort = null;
  revision++; baseDir = null; baseDirPromise = null; etag = null; inFlight = null;
  serverRows = {}; changes.clear(); localRemovals.clear();
  set({ capability: "unknown", status: "idle", byRelPath: {}, count: 0, removedRelPaths: new Set() });
}

function writeRow(row: UserLibraryRow) {
  if (!row?.relPath) return;
  serverRows[row.relPath] = row;
  publishRows();
}

/** Record plays only for saved songs because the backend can create missing library rows.
 * Ignore play-count failures so they cannot interrupt audio playback. */
export async function recordPlay(track: TrackLocator | string | null | undefined) {
  const version = revision;
  const relPath = relPathOf(track);
  if (!relPath || state.capability !== "ready" || !state.byRelPath[relPath]) return;
  try {
    if (hasBridge()) {
      await bridge().invoke('offline:play', { trackKey: relPath, listenedAt: Math.floor(Date.now() / 1000), clientPlayId: crypto.randomUUID() });
      return;
    }
    const response = await fetch(apiUrl("/api/me/plays")!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ relPath } satisfies PlayBody),
    });
    if (!response.ok) return;
    const row: ApiData<"/api/me/plays", "post"> | null = await response.json().catch(() => null);
    if (version === revision && row && "relPath" in row && row.relPath) writeRow(row);
  } catch {
    /* a lost play count is not worth interrupting playback for */
  }
}

/* -------------------------------------------------------------- selectors */

export function useUserLibrary() {
  return useSyncExternalStore(subscribe, getState, getState);
}

// Clear rows before loading a changed identity so accounts cannot briefly share displayed data.
if (typeof window !== "undefined") {
  // Retry when identity resolves because the first load can run before /api/me answers.
  subscribeIdentity(() => {
    if (state.status === "idle") load();
  });

  subscribeToken(() => {
    resetLibrary();
    load();
  });
}
