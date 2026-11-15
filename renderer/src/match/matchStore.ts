import { useSyncExternalStore } from 'react';
import { relPathOf } from '@state/userLibraryStore';
import { lyricsKeyOf } from '../lyrics/lyricsStore';
import type { components } from '../api/generated/schema';

type Request = components['schemas']['MatchRequest'];
export type MatchScope = Pick<Request, 'albumKey' | 'relPaths'> & { title?: string };
export type MatchSong = { path?: string; relPath?: string; title?: string };
let current: MatchScope | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

/** Public entry point for the library health page and every matching surface. */
export function openMatch(scope: MatchScope) { current = scope; emit(); }
export function openSongMatch(song: MatchSong) {
  const rel = relPathOf(song) || lyricsKeyOf(song);
  if (rel) openMatch({ relPaths: [rel], title: song.title });
}
export function closeMatch() { current = null; emit(); }
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useMatchScope() { return useSyncExternalStore(subscribe, () => current, () => null); }
