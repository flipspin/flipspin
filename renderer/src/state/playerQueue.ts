import { buildCoverImageUrl, parseTrackPath } from "@lib/api";
import { albumStub } from "@lib/albumStub";

/**
 * The pure half of the player: what a queued track looks like, how the queue is
 * persisted and restored, and how a shuffle is drawn. `AudioPlayerContext` owns
 * the state; everything here is a function of its arguments (and of
 * `localStorage`, for the two persistence helpers).
 */

/** The album slice a queued track carries; `albumStub`'s shape. */
export interface PlayerAlbum {
  album?: string | null;
  name?: string;
  artist?: string | null;
  path?: string | null;
  year?: string | number | null;
  genre?: unknown;
  cover?: string | null;
  /** Only on tracks saved by an older build; `slim` drops it. */
  tracks?: unknown[];
}

/**
 * A track as the player holds it. `url_path` is a backend media URL; under
 * Tauri `withMediaAccess` routes it through `krobi-media://` with no token, but
 * a queue saved by an older build can still carry `?access_token=`, so anything
 * that parses it must strip the query string.
 */
export interface PlayerTrack {
  path: string;
  title?: string;
  artist?: string;
  album?: PlayerAlbum | string | null;
  albumCover?: string | null;
  url_path?: string;
  [key: string]: unknown;
}

export const STORAGE_QUEUE = "playerQueue";
export const STORAGE_INDEX = "playerQueueIndex";
export const STORAGE_NOW = "playerNowPlaying";
export const STORAGE_SHUFFLE = "playerShuffleEnabled";
// Pre-shuffle ("natural") queue order, persisted separately from the live
// (possibly shuffled) STORAGE_QUEUE so disabling shuffle after a restart can
// restore the true order instead of freezing in the shuffled one.
export const STORAGE_BASE = "playerQueueBase";
export const HISTORY_CAP = 50;

// Fisher–Yates: produces a uniformly random permutation without mutating the input.
export function shuffleArray<T>(input: readonly T[], random: () => number = Math.random): T[] {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// A track saved by an older build carries its whole album, sibling tracks
// included (~2.6 KB each); the stub is all anything reads. Slimming on load
// migrates a persisted queue the first time it is written back.
export function slim<T>(track: T): T {
  if (!track || typeof track !== "object") return track;
  const album = (track as { album?: unknown }).album;
  if (!album || typeof album !== "object" || !("tracks" in album)) return track;
  return { ...track, album: albumStub(album, (album as PlayerAlbum).cover) };
}

export const slimAll = <T>(tracks: T): T => (Array.isArray(tracks) ? (tracks.map(slim) as T) : tracks);

export interface PersistedPlayer {
  nowPlaying: PlayerTrack | null;
  queue: PlayerTrack[];
  base: PlayerTrack[];
}

/** What the last session left in localStorage; empty on anything unreadable. */
export function loadPersisted(storage: Storage = localStorage): PersistedPlayer {
  try {
    const now = storage.getItem(STORAGE_NOW);
    const queueRaw = storage.getItem(STORAGE_QUEUE);
    const indexRaw = storage.getItem(STORAGE_INDEX);
    const baseRaw = storage.getItem(STORAGE_BASE);
    if (now) {
      const nowPlaying = slim(JSON.parse(now));
      const queue = queueRaw ? slimAll(JSON.parse(queueRaw)) : [];
      // Fall back to the (possibly shuffled) queue only if no baseline was
      // stored; e.g. data saved by an older build before STORAGE_BASE existed.
      const base = baseRaw ? slimAll(JSON.parse(baseRaw)) : queue;
      return { nowPlaying, queue, base };
    }
    if (queueRaw && indexRaw !== null) {
      const queue = slimAll(JSON.parse(queueRaw));
      const currentIndex = parseInt(indexRaw, 10);
      if (Array.isArray(queue) && queue.length > 0 && currentIndex >= 0 && currentIndex < queue.length) {
        const nowPlaying = queue[currentIndex];
        const nextQueue = [...queue.slice(currentIndex + 1)];
        return { nowPlaying, queue: nextQueue, base: nextQueue };
      }
    }
  } catch {
    /* ignore */
  }
  return { nowPlaying: null, queue: [], base: [] };
}

/**
 * What a shuffle draws from: the play's whole context minus the song that is
 * playing, plus anything queued by hand that is not part of that context. With
 * no context (a queue built by hand) it is just the queue.
 */
export function shufflePool(context: readonly PlayerTrack[], base: PlayerTrack[], current: PlayerTrack | null): PlayerTrack[] {
  if (!context.length) return base;
  const inContext = new Set(context.map((t) => t?.path));
  return [
    ...context.filter((t) => t && t.path !== current?.path),
    ...base.filter((t) => t && !inContext.has(t.path)),
  ];
}

/**
 * The list without ONE occurrence of `path` (the first). Removing by index
 * rather than filtering by path matters when the same track sits in the queue
 * twice; filtering would drop both. Returns the same array when absent.
 */
export function withoutOne(list: PlayerTrack[], path: string | null | undefined): PlayerTrack[] {
  if (!path) return list;
  const idx = list.findIndex((t) => t?.path === path);
  if (idx === -1) return list;
  return [...list.slice(0, idx), ...list.slice(idx + 1)];
}

export interface NowPlayingMetadata {
  title: string;
  artist: string;
  album: string;
  artwork: { src: string; sizes: string; type: string }[];
}

/**
 * What the Now Playing widget and the lock screen show for a track. Artwork is
 * the album cover; under Tauri that is a krobi-media:// URL, which WebKit
 * fetches like any other image.
 */
export function nowPlayingMetadata(track: PlayerTrack): NowPlayingMetadata {
  const albumObj = track.album && typeof track.album === "object" ? track.album : null;
  const dir = parseTrackPath(track.path).albumName;
  const cover = albumObj?.cover || track.albumCover || (dir ? buildCoverImageUrl(dir) : null);
  return {
    title: track.title || "",
    artist: track.artist || albumObj?.artist || "",
    album: albumObj ? albumObj.album || albumObj.name || "" : typeof track.album === "string" ? track.album : "",
    artwork: cover ? [{ src: cover, sizes: "512x512", type: "image/jpeg" }] : [],
  };
}
