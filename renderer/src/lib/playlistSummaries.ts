import { subscribeToken } from "./authToken";
import { backendRequest } from "./api";
import { useSyncExternalStore } from "react";

import type { ApiData } from "../data/http";

export type PlaylistSummaries = ApiData<"/api/playlists", "get">;
let inFlight: Promise<PlaylistSummaries> | null = null;
let latestRequest: Promise<PlaylistSummaries> | null = null;
let cached: PlaylistSummaries | null = null;
let cachedAt = 0;
let liveAt = 0;
let revision = 0;
const listeners = new Set<() => void>();
const EMPTY: PlaylistSummaries = [];
const emit = () => listeners.forEach(listener => listener());
subscribeToken(() => { revision++; cached = null; cachedAt = 0; liveAt = 0; inFlight = null; latestRequest = null; emit(); });
const snapshot = () => cached || EMPTY;
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the access-filtered list already loaded by the shell; never fetch on search. */
export function usePlaylistSummaries() {
  return useSyncExternalStore(subscribe, snapshot);
}

// Long enough for sibling components mounting in sequence to share the result,
// short enough that this is request coalescing rather than application caching.
const COALESCE_WINDOW_MS = 1000;

export function fetchPlaylistSummaries({ force = false }: { force?: boolean } = {}): Promise<PlaylistSummaries> {
  if (!force && inFlight) return inFlight;
  if (!force && cached && Date.now() - cachedAt < COALESCE_WINDOW_MS) {
    return Promise.resolve(cached);
  }

  const version = revision;
  const request: Promise<PlaylistSummaries> = backendRequest("/api/playlists")
    .then((response) => {
      if (version !== revision) throw new Error("account-changed");
      // All callers waiting on an older read receive the newest list as well.
      if (latestRequest !== request) return latestRequest!;
      const raw = response.body || "";
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 200)}`);
      const parsed: PlaylistSummaries = raw ? JSON.parse(raw) : [];
      const snapshotAt = response.headers?.["x-krobi-snapshot-at"];
      // A saved copy can finish after reconnect or a successful live read.
      // Return the retained list too, so local component state cannot regress.
      if (snapshotAt != null && liveAt && Number(snapshotAt) * 1000 <= liveAt) return cached!;
      cached = Array.isArray(parsed) ? parsed : [];
      cachedAt = Date.now();
      if (snapshotAt == null) liveAt = cachedAt;
      emit();
      return cached;
    })
    .catch((error: unknown) => {
      if (version === revision && latestRequest !== request) return latestRequest!;
      throw error;
    })
    .finally(() => {
      if (inFlight === request) inFlight = null;
    });

  latestRequest = inFlight = request;
  return request;
}
