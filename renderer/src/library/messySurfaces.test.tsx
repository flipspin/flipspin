/** the real library page and URL builders on the wire listing. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../data/hooks/use-library-missing', () => ({ useLibraryMissing: () => new Set<string>() }));
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { writeFileSync } from 'node:fs';
import fixture from './messyListing.fixture.json';
import oracle from '../../../backend/tests/fixtures/messy_surface_oracle.json';
import { albumDirName, buildAlbumCoverUrl, buildMediaUrl, buildTrackSrc, parseTrackPath } from '../lib/api';
import { keysForPath, setLibraryRoot } from './libraryKeys';

const mocks = vi.hoisted(() => ({ play: vi.fn(), open: vi.fn() }));
vi.mock('@state/AudioPlayerContext', () => ({ useAudioPlayer: () => ({
  play: mocks.play, isPlaying: false, selectedTrack: null, setIsPlaying: vi.fn(),
  setSelectedTrack: vi.fn(), addToQueue: vi.fn(), addNextInQueue: vi.fn(),
}) }));
vi.mock('@state/SettingsContext', () => ({ useSettings: () => ({}) }));
vi.mock('../state/useStatus', () => ({ useStatus: () => ({ clear: vi.fn() }) }));
vi.mock('../albums/hooks/useAlbumActions', () => ({ useAlbumActions: () => ({ sendItems: () => [] }) }));
vi.mock('./tracks/useAddToPlaylistMenu', () => ({ useAddToPlaylistMenu: () => ({ refresh: vi.fn(), submenu: () => [] }) }));
vi.mock('../albums/hooks/useDeviceDownloads', () => ({ useDeviceDownloads: () => ({ isDownloaded: () => false }) }));
vi.mock('../lyrics/useLyricsMenu', () => ({ useLyricsMenu: () => ({ items: () => [] }) }));
vi.mock('../lyrics/lyricStates', async (original) => ({
  ...(await original<typeof import('../lyrics/lyricStates')>()),
  useLyricStates: () => ({ states: {}, filterStates: {}, filterCounts: { synced: 0, plain: 0, pending: 0, none: 30, instrumental: 0, queued: 0 }, refresh: vi.fn() }),
}));
vi.mock('../stems/libraryStems', async (original) => ({
  ...(await original<typeof import('../stems/libraryStems')>()),
  useLibraryStems: () => ({ keys: new Set(), counts: { all: 30, ready: 0, none: 30 }, query: {} }),
}));
vi.mock('../state/userLibraryStore', () => ({
  useUserLibrary: () => ({ capability: 'no-user', byRelPath: {}, count: 0 }),
  relPathOf: (track: { relPath?: string }) => track.relPath,
  load: vi.fn(),
}));
vi.mock('../browse/navigationStore', async (original) => ({
  ...(await original<typeof import('../browse/navigationStore')>()),
  openLibraryAlbum: mocks.open,
}));
vi.mock('../plugins', () => ({ pluginTrackMenuItems: () => [] }));
vi.mock('./tracks/TrackInfoModal', () => ({ default: () => null, TrackInfoHost: () => null }));
vi.mock('../lyrics/LyricsModal', () => ({ default: () => null }));

import AlbumList from '../albums/AlbumList';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('krobi.libraryView', JSON.stringify({ layout: 'grid', sort: { field: 'album', dir: 'asc' } }));
  setLibraryRoot('/fixture/Music');
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});
afterEach(() => {
  cleanup();
  setLibraryRoot(null);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it('renders every nested album on the library page and opens and plays the deep album', () => {
  const { container } = render(<QueryClientProvider client={new QueryClient()}><AlbumList albums={fixture.albums} /></QueryClientProvider>);
  expect(screen.queryByText('La biblioteca falló')).toBeNull();
  expect(container.querySelectorAll('.library-grid .cover-card')).toHaveLength(20);
  // Inspect each open control once instead of recomputing visibility for the
  // entire large tree for every album on a CPU-starved worker.
  const openButtons = [...container.querySelectorAll<HTMLButtonElement>('.library-grid .cover-card__open')];
  for (const button of openButtons) expect(button).toHaveAccessibleName(button.getAttribute('aria-label')!.replace(/\s+/g, ' ').trim());
  const openNames = openButtons.map(button => button.getAttribute('aria-label')!.replace(/\s+/g, ' ').trim());
  for (const album of fixture.albums) {
    expect(openNames).toContain(`Abrir ${album.album}`.replace(/\s+/g, ' ').trim());
  }
  const deep = openButtons.find(button => button.title === 'Deep Album')!;
  fireEvent.click(deep);
  expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ mediaKey: '04-deep∕archive∕old∕backups∕music∕Deep Artist∕Deep Album' }));
  fireEvent.click(within(deep.closest<HTMLElement>('.cover-card')!).getByRole('button', { name: 'Reproducir Deep Album' }));
  expect(mocks.play).toHaveBeenCalled();
  expect(JSON.stringify(mocks.play.mock.calls)).toContain('04-deep%E2%88%95archive');
});

it('derives all playlist keys and builds media and cover URLs from wire keys', () => {
  const urls: { path: string; url: string; kind: string }[] = [];
  for (const row of oracle.files.filter(r => r.listed)) {
    const absolute = `/fixture/Music/${row.path}`;
    expect(keysForPath(absolute, '/fixture/Music')).toEqual({ album: row.mediaKey, file: row.fileKey });
    expect(parseTrackPath(absolute)).toEqual({ albumName: row.mediaKey, fileName: row.fileKey });
    const album = fixture.albums.find(a => a.mediaKey === row.mediaKey)!;
    expect(album).toBeTruthy();
    expect(albumDirName(album)).toBe(row.mediaKey);
    const track = album.tracks.find(t => t.path === absolute)!;
    const url = buildMediaUrl(row.mediaKey, row.fileKey);
    const expected = `/api/media/${encodeURIComponent(row.mediaKey!)}/${encodeURIComponent(row.fileKey!)}`;
    expect(new URL(url).pathname).toBe(expected);
    expect(new URL(buildTrackSrc({ path: absolute })).pathname).toBe(expected);
    // url_path on the listing is raw; browsers escape it when loading it.
    expect(decodeURIComponent(new URL(buildTrackSrc(track)).pathname)).toBe(decodeURIComponent(expected));
    expect(new URL(buildAlbumCoverUrl(album)).pathname).toBe(`/api/media/${encodeURIComponent(row.mediaKey!)}/cover.jpg`);
    urls.push({ path: row.path, url, kind: 'audio' });
  }
  for (const album of fixture.albums) {
    urls.push({ path: album.mediaKey, url: buildAlbumCoverUrl(album), kind: 'cover' });
  }
  // Optional audit handoff: the Python TestClient replays actual JS URLs.
  if (process.env.PLU129_RENDERER_URLS) writeFileSync(process.env.PLU129_RENDERER_URLS, JSON.stringify(urls, null, 2));
});
