import { bridge, hasBridge } from "../bridge";
import { queueChange } from "../offline/snapshots";
import { getForcedOffline } from "../offline/mode";
import { connectionStore } from "../connection/connection";
import { apiUrl, backendRequest } from "@lib/api";
import { playlistAccessMessage } from "@lib/playlistAccess";
import type { PlaylistTrack } from "./playlistTracks";

/**
 * The playlist routes the Playlists page calls. Each answers in a shape the page
 * can act on without re-reading HTTP: data, or `denied` with the sentence for a
 * 403/404 that `playlistAccessMessage` explains, or a thrown `Error` whose
 * message is the status and a preview of the body.
 */

export interface PlaylistSummary {
  name: string;
  [key: string]: unknown;
}

export interface PlaylistDetail {
  name: string;
  tracks?: PlaylistTrack[];
  [key: string]: unknown;
}

type BackendResponse = { ok: boolean; status: number; headers: Record<string, string>; body?: string };

export type Outcome<T> = { ok: true; data: T } | { ok: false; denied: string };

const path = (name: string) => `/api/playlists/${encodeURIComponent(name)}`;
const preview = (response: BackendResponse) => (response.body || "").slice(0, 200);

function parseJson<T>(response: BackendResponse, empty: T): T {
  const rawText = response.body || "";
  try {
    return rawText ? JSON.parse(rawText) : empty;
  } catch {
    throw new Error(`Invalid JSON (${response.headers["content-type"] || ""}): ${preview(response)}`);
  }
}

/** A failed answer: `denied` when it is an access verdict, otherwise throws. */
function refuse(response: BackendResponse): { ok: false; denied: string } {
  const explained = playlistAccessMessage(response.status);
  if (explained) return { ok: false, denied: explained };
  throw new Error(`HTTP ${response.status}: ${preview(response)}`);
}

export async function fetchPlaylists(): Promise<PlaylistSummary[]> {
  const response: BackendResponse = await backendRequest("/api/playlists");
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${preview(response)}`);
  const data = parseJson<unknown>(response, []);
  return Array.isArray(data) ? data : [];
}

// Treat 403 as access denial so an existing playlist does not look like a network failure.
export async function fetchPlaylist(name: string, fresh = false): Promise<Outcome<PlaylistDetail>> {
  // A committed delete must bypass the native snapshot's short sync throttle.
  let response: BackendResponse;
  if (fresh) {
    const result = await fetch(apiUrl(path(name)), { cache: 'no-store' });
    response = { ok: result.ok, status: result.status, headers: Object.fromEntries(result.headers.entries()), body: await result.text() };
  } else {
    response = await backendRequest(path(name));
  }
  if (!response.ok) return refuse(response);
  return { ok: true, data: parseJson<PlaylistDetail>(response, {} as PlaylistDetail) };
}

export async function renamePlaylist(current: string, newName: string): Promise<Outcome<null>> {
  const response: BackendResponse = await backendRequest(path(current), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new_name: newName }),
  });
  return response.ok ? { ok: true, data: null } : refuse(response);
}

export async function deletePlaylist(name: string): Promise<Outcome<null>> {
  const response: BackendResponse = await backendRequest(path(name), { method: "DELETE" });
  return response.ok ? { ok: true, data: null } : refuse(response);
}

/** Replace the playlist's songs. Answers the raw `Response`; the caller decides what a failure says. */
export async function putPlaylistTracks(name: string, tracks: PlaylistTrack[]): Promise<Response> {
  if (hasBridge()) {
    const snapshot = await bridge().invoke('offline:snapshot', { kind: `playlist:${name}` });
    if (!snapshot?.etag) throw new Error('playlist-version-required');
    const connection = connectionStore.getSnapshot();
    const offline = getForcedOffline() || (connection.kind === 'ready' && connection.value?.connection.state === 'unreachable');
    if (offline) {
      await queueChange('playlist-edit', { name, tracks, etag: snapshot.etag, base: JSON.parse(snapshot.body) as unknown });
      return new Response(JSON.stringify({ success: true, queued: true }), { status: 200 });
    }
    const response = await backendRequest(`${path(name)}/tracks`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'If-Match': snapshot.etag, 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify(tracks),
    });
    return new Response(response.body, { status: response.status, headers: response.headers });
  }
  const response = await backendRequest(`${path(name)}/tracks`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(tracks) });
  return new Response(response.body, { status: response.status, headers: response.headers });
}
