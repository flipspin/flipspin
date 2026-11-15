import { useMemo } from 'react';
import { parseTrackPath } from '@lib/api';
import { msg } from '../i18n';
import { useSplitDeletes } from '../settings/splitDeletes';
import { trackKey } from './stemApi';
import { useSplits } from './useStemSong';

export const STEM_FILTERS = [
  { value: 'all', label: msg("All") }, { value: 'ready', label: msg("Split into stems") }, { value: 'none', label: msg("Not split") },
];
export function libraryStemKey(track: { url_path?: string; path?: string; relPath?: string }) {
  if (track.url_path) {
    const match = new URL(track.url_path, 'http://library').pathname.match(/\/(?:api\/)?media\/([^/]+)\/([^/]+)$/);
    if (match) return trackKey({ album: decodeURIComponent(match[1]), file: decodeURIComponent(match[2]) });
  }
  const { albumName, fileName } = parseTrackPath(track.relPath || track.path);
  return albumName && fileName ? trackKey({ album: albumName, file: fileName }) : null;
}
export function useLibraryStems(albums: { tracks: Parameters<typeof libraryStemKey>[0][] }[]) {
  const query = useSplits();
  const { hidden } = useSplitDeletes();
  const keys = useMemo(() => new Set((query.data?.splits ?? []).filter(s => !hidden.has(trackKey(s))).map(trackKey)), [query.data, hidden]);
  const tracks = albums.flatMap(a => a.tracks);
  const ready = tracks.filter(t => keys.has(libraryStemKey(t))).length;
  return { keys, counts: { all: tracks.length, ready, none: tracks.length - ready }, query };
}
