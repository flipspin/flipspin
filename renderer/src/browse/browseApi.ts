/** apiAuth supplies credentials globally. Keep provider failures actionable:
 * 409 requires enabling a provider, 404 means the entity is absent, and other failures can be retried. */
import { apiUrl } from "@lib/api";
import type { ApiData } from "../data";
import type { components } from "../api/generated/schema";
import type { AlbumData, ArtistData, PlaylistData, GenreData, SearchData, BrowseTrack, ReplacementReceipt } from "./browse.types";
export type { OwnershipVerdict } from "./browse.types";
import i18n from "../i18n";

export class BrowseError extends Error {
  kind: string;
  status: number;
  constructor(message: string, kind: string, status: number) {
    super(message);
    this.name = "BrowseError";
    this.kind = kind;
    this.status = status;
  }
}

async function get(path: string, { signal }: { signal?: AbortSignal } = {}): Promise<unknown> {
  let response;
  try {
    response = await fetch(apiUrl(path), { signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") throw e;
    throw new BrowseError(i18n.t("Couldn't connect to your nest."), "offline", 0);
  }

  if (response.ok) return response.json();

  let detail = null;
  try {
    const body: unknown = await response.json();
    detail = isRecord(body) && typeof body.detail === "string" ? body.detail : null;
  } catch {
    detail = null;
  }

  if (response.status === 409) {
    throw new BrowseError(detail || i18n.t("No active source can answer."), "unavailable", 409);
  }
  if (response.status === 404) {
    throw new BrowseError(detail || i18n.t("Not found."), "notFound", 404);
  }
  throw new BrowseError(detail || i18n.t("Error {{status}}", { status: response.status }), "failed", response.status);
}

export async function fetchAlbum(provider: string, id: string, { refresh = false, signal }: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<AlbumData> {
  return validated(await get(
    `/api/browse/album/${encodeURIComponent(provider)}/${encodeURIComponent(id)}${refresh ? "?refresh=true" : ""}`,
    { signal },
  ), isAlbumPage);
}

export async function fetchArtist(provider: string, id: string, { refresh = false, signal }: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ArtistData> {
  return validated(await get(
    `/api/browse/artist/${encodeURIComponent(provider)}/${encodeURIComponent(id)}${refresh ? "?refresh=true" : ""}`,
    { signal },
  ), isArtistPage);
}

export async function fetchPlaylist(provider: string, id: string, { refresh = false, signal }: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<PlaylistData> {
  return validated(await get(
    `/api/browse/playlist/${encodeURIComponent(provider)}/${encodeURIComponent(id)}${refresh ? "?refresh=true" : ""}`,
    { signal },
  ), isPlaylistPage);
}

export async function fetchGenre(provider: string, id: string, { refresh = false, signal }: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<GenreData> {
  return validated(await get(
    `/api/browse/genre/${encodeURIComponent(provider)}/${encodeURIComponent(id)}${refresh ? "?refresh=true" : ""}`,
    { signal },
  ), isGenrePage);
}

export async function search(query: string, { types, limit = 20, mode = "full", signal }: { types?: string[]; limit?: number; mode?: "typing" | "full"; signal?: AbortSignal } = {}) {
  const params = new URLSearchParams({ q: query, limit: String(limit), mode });
  (types || []).forEach((t) => params.append("types", t));
  return validated(await get(`/api/browse/search?${params.toString()}`, { signal }), isSearch);
}

/** Batch ownership to avoid a server index walk per track.
 * Return degraded ownership on failure so catalog browsing remains usable. */
export async function checkOwnership(tracks: BrowseTrack[], { signal }: { signal?: AbortSignal } = {}): Promise<NonNullable<ApiData<"/api/library/ownership", "post">["results"]>> {
  if (!tracks?.length) return [];
  try {
    const response = await fetch(apiUrl("/api/library/ownership"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        tracks: tracks.map((t) => ({
          title: t.title,
          artist: t.artistName || null,
          durationSeconds: t.durationSeconds ?? null,
        })),
      } satisfies components["schemas"]["OwnershipRequest"]),
    });
    if (!response.ok) return [];
    const body: ApiData<"/api/library/ownership", "post"> = await response.json();
    return body?.results || [];
  } catch {
    return [];
  }
}

/** Forward recording metadata so acquisition can reject the wrong video.
 * The returned progress id uses the shared download-progress stream. */
export { submitAcquisition as acquireTracks } from '../acquisition/api';

export async function acquireReplacementTracks(tracks: BrowseTrack[], { folder }: Pick<components["schemas"]["AcquireRequest"], "folder"> = {}): Promise<ReplacementReceipt> {
  const response = await fetch(apiUrl("/api/browse/acquire"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      folder: folder || null,
      tracks: tracks.map((t) => ({
        title: t.title,
        artistName: t.artistName || null,
        albumTitle: t.albumTitle || null,
        trackPosition: t.trackPosition ?? null,
        durationSeconds: t.durationSeconds ?? null,
        coverUrl: t.coverUrl || null,
        isrc: t.isrc || null,
        // "Replace with this version": the server path of the file this one
        // takes the place of (`browse/resolve.ts`).
        replaces: t.replaces || null,
      })),
    } satisfies components["schemas"]["AcquireRequest"]),
  });

  if (response.ok) return validated(await response.json(), isReceipt);

  let detail = null;
  try {
    const body: unknown = await response.json();
    detail = isRecord(body) && typeof body.detail === "string" ? body.detail : null;
  } catch {
    detail = null;
  }
  if (response.status === 409) {
    throw new BrowseError(detail || i18n.t("No active audio source."), "unavailable", 409);
  }
  throw new BrowseError(detail || i18n.t("Error {{status}}", { status: response.status }), "failed", response.status);
}


// Only unmodelled bodies need runtime checks. Keep optional provider fields
// optional, and retain the original object (including fields newer servers add).
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function optional(value: unknown, check: (v: unknown) => boolean): boolean {
  return value == null || check(value);
}
const string = (v: unknown): v is string => typeof v === "string";
const number = (v: unknown): v is number => typeof v === "number";
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(string);
function fields(value: Record<string, unknown>, keys: string[], check: (v: unknown) => boolean): boolean {
  return keys.every(key => optional(value[key], check));
}
function ref(value: unknown): boolean {
  return isRecord(value) && string(value.provider) && string(value.id) && optional(value.url, string);
}
export function isBrowseTrack(value: unknown): value is BrowseTrack {
  return isRecord(value) && string(value.title)
    && fields(value, ["artistName", "albumTitle", "coverUrl", "isrc", "replaces"], string)
    && fields(value, ["durationSeconds", "trackPosition"], number)
    && fields(value, ["ref", "albumRef"], ref)
    && optional(value.explicit, v => typeof v === "boolean");
}
function album(value: unknown): boolean {
  return isRecord(value) && string(value.title) && ref(value.ref)
    && fields(value, ["artistName", "coverUrl", "releaseDate", "recordType", "label"], string)
    && optional(value.artistRef, ref) && optional(value.genres, strings);
}
function artist(value: unknown): boolean {
  return isRecord(value) && string(value.name) && ref(value.ref)
    && optional(value.imageUrl, string) && optional(value.albumCount, number);
}
function playlist(value: unknown): boolean {
  return isRecord(value) && string(value.title) && ref(value.ref)
    && fields(value, ["owner", "pictureUrl", "description"], string) && optional(value.trackCount, number);
}
function genre(value: unknown): boolean {
  return isRecord(value) && string(value.name) && ref(value.ref) && optional(value.imageUrl, string);
}
function list(check: (v: unknown) => boolean) {
  return (value: unknown) => Array.isArray(value) && value.every(check);
}
function isAlbumPage(value: unknown): value is AlbumData {
  return isRecord(value) && album(value.album) && list(isBrowseTrack)(value.tracks);
}
function isArtistPage(value: unknown): value is ArtistData {
  return isRecord(value) && artist(value.artist) && optional(value.topTracks, list(isBrowseTrack))
    && optional(value.albums, list(album)) && optional(value.related, list(artist))
    && optional(value.playlists, list(playlist)) && optional(value.partial, strings);
}
function isPlaylistPage(value: unknown): value is PlaylistData {
  return isRecord(value) && playlist(value.playlist) && list(isBrowseTrack)(value.tracks);
}
function isGenrePage(value: unknown): value is GenreData {
  return isRecord(value) && genre(value.genre) && optional(value.tracks, list(isBrowseTrack))
    && optional(value.albums, list(album)) && optional(value.artists, list(artist))
    && optional(value.playlists, list(playlist));
}
function isSearch(value: unknown): value is SearchData {
  return isRecord(value) && optional(value.query, string) && optional(value.tracks, list(isBrowseTrack))
    && optional(value.albums, list(album)) && optional(value.artists, list(artist))
    && optional(value.playlists, list(playlist)) && optional(value.failed, strings);
}
function isReceipt(value: unknown): value is ReplacementReceipt {
  return isRecord(value) && number(value.total) && optional(value.progress_id, string)
    && (!value.total || string(value.progress_id)) && optional(value.alreadyPresent, Array.isArray)
    && optional(value.linking, string);
}
function validated<T>(value: unknown, check: (v: unknown) => v is T): T {
  if (!check(value)) throw new TypeError("Invalid browse payload");
  return value;
}
