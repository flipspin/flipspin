import { useSyncExternalStore } from 'react';
import { getLibraryRoot, keysForPath, keysForSegments, subscribeLibraryRoot } from './libraryKeys';

type Track = { path?: string | null; relPath?: unknown; mediaKey?: unknown; missingFromNest?: unknown };
type Album = { tracks?: Track[] };

/** The same two server key segments used by playlists and queued songs. */
export function trackLibraryKey(track: Track): string | null {
  if (typeof track.relPath === 'string' && track.relPath) return track.relPath;
  if (typeof track.mediaKey === 'string' && track.mediaKey.includes('/')) return track.mediaKey;
  const path = track.path;
  if (!path) return null;
  const keys = keysForPath(path, getLibraryRoot()) ?? (!path.startsWith('/') && !/^[A-Za-z]:/.test(path)
    ? keysForSegments(path.split(/[/\\]/).filter(Boolean)) : null);
  return keys ? `${keys.album}/${keys.file}` : null;
}

let revision: unknown;
let listing: readonly Album[] | undefined;
let present = new Set<string>();
let paths = new Set<string>();
let absent = new Set<string>();
let check: typeof isTrackPresent = track => isTrackPresent(track);
const listeners = new Set<() => void>();
const publish = () => { check = track => isTrackPresent(track); listeners.forEach(listener => listener()); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Undefined means still loading. A validated empty snapshot is authoritative. */
export function setLibraryPresence(albums?: readonly Album[], nextRevision: unknown = albums): void {
  if (listing === albums && revision === nextRevision) return;
  if (revision !== nextRevision) absent = new Set();
  revision = nextRevision;
  listing = albums;
  rebuild();
}

function rebuild() {
  present = new Set(); paths = new Set();
  for (const album of listing ?? []) for (const track of album.tracks ?? []) {
    if (track.missingFromNest) continue;
    const key = trackLibraryKey(track);
    if (key) present.add(key);
    if (track.path) paths.add(track.path);
  }
  publish();
}

subscribeLibraryRoot(rebuild);

export function isTrackPresent(track: Track): boolean {
  const key = trackLibraryKey(track);
  if ((key && absent.has(key)) || (track.path && absent.has(track.path))) return false;
  if (listing === undefined) return true;
  // Snapshot paths also identify legacy queue entries before the root arrives.
  return !!(track.path && paths.has(track.path)) || !!(key && present.has(key));
}

export function markTrackAbsent(track: Track): void {
  const key = trackLibraryKey(track) ?? track.path;
  if (!key || absent.has(key)) return;
  absent.add(key); publish();
}

/** One subscription per list/player, with constant-time checks per track. */
export function useTrackPresence(): typeof isTrackPresent {
  return useSyncExternalStore(subscribe, () => check);
}
