// Read credentials at request time so sign-in changes affect existing callers.
import type { ApiData } from "../data/http";

export type BackendRequestOptions = Omit<RequestInit, "headers" | "body"> & {
  headers?: Record<string, string>;
  body?: string | null;
};
/** Transport envelope shared by browser fetch, native IPC and saved snapshots. */
export interface BackendResult {
  ok: boolean;
  status: number;
  statusText?: string;
  headers: Record<string, string>;
  body: string;
  bytes?: ArrayBuffer;
}
export type AlbumLocator = Partial<Pick<ApiData<"/api/listar-albums-con-metadata", "get">[number], "album" | "path" | "mediaKey">> & { dirName?: string };
type ListedTrack = ApiData<"/api/listar-albums-con-metadata", "get">[number]["tracks"][number];
export type TrackLocator = Partial<Pick<ListedTrack, "path" | "relPath" | "url_path">>;

// Persisted player tracks also carry the server key. Declare it explicitly so
// consumers do not inherit `unknown` from the queue's extension-field index.
declare module "../state/playerQueue" {
  interface PlayerTrack { relPath?: ListedTrack["relPath"]; }
}

import { getForcedOffline } from "../offline/mode";
import { snapshotResponse, offlineMutation } from "../offline/snapshots";
import { getApiToken } from "./authToken";
import { getLibraryRoot, keysForPath } from "./libraryKeys";

export const API_BASE_URL: string =
  (typeof window !== "undefined" && window.desktopAPI?.backendUrl) ||
  import.meta.env.VITE_API_BASE_URL ||
  "http://localhost:8000";

const MEDIA_PROXY_BASE_URL =
  (typeof window !== "undefined" && window.desktopAPI?.mediaProxyUrl) || "";

// Use the shell's server mode when available; browser development falls back to VITE_API_BASE_URL.
export const IS_REMOTE_BACKEND =
  (typeof window !== "undefined" && window.desktopAPI)
    ? Boolean(window.desktopAPI.backendIsRemote)
    : !/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(API_BASE_URL);

/** Auth header for anything that can send headers; which is the preferred path. */
export function apiAuthHeaders(): Record<string, string> {
  const token = getApiToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Append the token as a query parameter.
 *
 * ONLY for the browser APIs that physically cannot send a header: `EventSource`
 * (no headers in the spec) and image URLs and browser-only media URLs.
 * Everything else must use apiAuthHeaders(). See apiAuth.js for the tradeoff.
 */
export function withApiToken<T extends string | null | undefined>(url: T): T | string {
  const token = getApiToken();
  if (!url || !token) return url;
  if (!url.startsWith(API_BASE_URL)) return url;
  // Replace stale query tokens in persisted media URLs so saved queues survive sign-in changes.
  const existing = url.match(/[?&]access_token=([^&]*)/);
  if (existing) {
    if (existing[1] === encodeURIComponent(token)) return url;
    return url.replace(/([?&]access_token=)[^&]*/, `$1${encodeURIComponent(token)}`);
  }
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}access_token=${encodeURIComponent(token)}`;
}

export function apiUrl(path: string | null | undefined) {
  if (!path) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(path)) return path;
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE_URL}${normalized}`;
}

/**
 * Route media through the native desktop boundary when one exists.
 *
 * Unlike a direct remote URL, this works with WebKit's anonymous-CORS audio
 * mode even against an older Flipspin server. Rust supplies the current bearer
 * token and forwards Range requests; the secret never enters the media URL.
 */
export function withMediaAccess<T extends string | null | undefined>(url: T): T | string {
  if (!url) return url;
  if (!MEDIA_PROXY_BASE_URL || url.startsWith(MEDIA_PROXY_BASE_URL)) {
    return MEDIA_PROXY_BASE_URL ? url : withApiToken(url);
  }
  try {
    const base = new URL(API_BASE_URL);
    const target = new URL(url);
    const basePath = base.pathname.replace(/\/$/, "");
    const inBasePath =
      target.pathname === basePath || target.pathname.startsWith(`${basePath}/`);
    if (target.origin !== base.origin || !inBasePath) return withApiToken(url);
    target.searchParams.delete("access_token");
    const suffix = target.pathname.slice(basePath.length) || "/";
    return `${MEDIA_PROXY_BASE_URL}${suffix}${target.search}`;
  } catch {
    return withApiToken(url);
  }
}

// A root render can make the same read from more than one legacy component
// (for example the sidebar and home screen both need playlist summaries).
// Sharing only the in-flight promise removes duplicate HTTP/IPC work without
// introducing stale-data semantics: the entry disappears as soon as it settles.
const pendingGetRequests = new Map<string, Promise<BackendResult>>();

export function backendRequest(path: string, options: BackendRequestOptions = {}): Promise<BackendResult> {
  const url = apiUrl(path)!;
  const method = options.method || "GET";
  const headers = { ...apiAuthHeaders(), ...(options.headers || {}) };
  const body = options.body ?? null;

  const execute = async (): Promise<BackendResult> => {
    const queued = await offlineMutation(url, method.toUpperCase(), body);
    if (queued) return { ok: true, status: 200, headers: {}, body: JSON.stringify(queued) };
    if (method.toUpperCase() === "GET") {
      const cached = await snapshotResponse(url);
      if (cached) return cached;
    }
    if (getForcedOffline()) throw new Error("offline-mode");
    if (typeof window !== "undefined" && window.desktopAPI?.requestBackend) {
      return window.desktopAPI.requestBackend({
        url,
        method,
        headers,
        body,
      });
    }

    // Send the merged headers so browser requests retain their auth credential.
    const response = await fetch(url, { ...options, method, headers, body });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: text,
    };
  };

  if (method.toUpperCase() !== "GET" || body != null || options.signal) return execute();

  const key = `${url}\n${JSON.stringify(headers)}`;
  const existing = pendingGetRequests.get(key);
  if (existing) return existing;

  const pending = execute().finally(() => pendingGetRequests.delete(key));
  pendingGetRequests.set(key, pending);
  return pending;
}

// Shared media URLs: the desktop proxy adds credentials; browser development
// retains query access for image consumers and the engine's Range fetches.
export function buildMediaUrl(albumName: string | null | undefined, fileName: string | null | undefined) {
  if (!albumName || !fileName) return null;
  return withMediaAccess(
    `${API_BASE_URL}/api/media/${encodeURIComponent(albumName)}/${encodeURIComponent(fileName)}`
  );
}

export function buildCoverImageUrl(albumName: string | null | undefined) {
  if (!albumName) return null;
  return withMediaAccess(`${API_BASE_URL}/api/media/${encodeURIComponent(albumName)}/cover.jpg`);
}

/** Media routes use the album directory, which can differ from its display name. */
export function albumDirName(album: AlbumLocator | string | null | undefined) {
  if (!album) return null;
  // The server says, for a nested library (`Artist∕Album`) as for a flat one.
  if (typeof album === "object" && album.mediaKey) return album.mediaKey;
  if (typeof album === "object" && album.path) {
    const keys = keysForPath(`${album.path}/x`, getLibraryRoot());
    if (keys) return keys.album;
  }
  const raw = typeof album === "string" ? album : album.path || album.dirName || "";
  const segments = String(raw).split(/[/\\]/).filter(Boolean);
  if (segments.length > 0) return segments[segments.length - 1];
  // No path to learn from: the display name is the only thing left, and for
  // three quarters of the library it is also right.
  return typeof album === "object" ? album.album || null : null;
}

/** Derive personal-library keys relative to the server root, folding nested folders.
 * Never use url_path: query credentials must not become part of a persisted identity.
 * Return null for tracks outside the library so callers can disable saving. */
export function relPathForTrack(track: TrackLocator | string | null | undefined, baseDir?: string | null) {
  if (track && typeof track === "object" && typeof track.relPath === "string") return track.relPath;
  const absolute = typeof track === "string" ? track : track?.path;
  const keys = keysForPath(absolute, baseDir);
  return keys ? `${keys.album}/${keys.file}` : null;
}

/** The cover URL for an album object, keyed correctly. Prefer this to passing a name. */
export function buildAlbumCoverUrl(album: AlbumLocator | string | null | undefined) {
  const dir = albumDirName(album);
  return dir ? buildCoverImageUrl(dir) : null;
}

/** One immutable thumbnail URL per album, shared by every song in that album. */
export function buildAlbumThumbUrl(albumDir: string | null | undefined, coverVersion?: unknown, size = 96) {
  if (!albumDir) return null;
  return withMediaAccess(`${API_BASE_URL}/api/media/${encodeURIComponent(albumDir)}/cover.jpg?size=${size}&v=${encodeURIComponent(`${coverVersion ?? ""}`)}`);
}

export function parseTrackPath(path: string | null | undefined) {
  if (!path) return { albumName: null, fileName: null };
  // Under the known root, the server's keys (a nested library folds its
  // folders into the album key); otherwise the last two segments, as before.
  const keys = keysForPath(path, getLibraryRoot());
  if (keys) return { albumName: keys.album, fileName: keys.file };
  const parts = path.split(/[/\\]/).filter(Boolean);
  if (parts.length < 2) return { albumName: null, fileName: parts[0] || null };
  return { albumName: parts[parts.length - 2], fileName: parts[parts.length - 1] };
}

// Every engine source goes through media access, including restored URLs.
export function buildTrackSrc(track: TrackLocator | null | undefined) {
  if (!track) return null;
  if (track.url_path) return withMediaAccess(apiUrl(track.url_path));
  if (!track.path) return null;
  const { albumName, fileName } = parseTrackPath(track.path);
  if (albumName && fileName) return buildMediaUrl(albumName, fileName);
  if (track.path.startsWith("/api") || track.path.startsWith("/media")) {
    return withMediaAccess(apiUrl(track.path));
  }
  return null;
}
