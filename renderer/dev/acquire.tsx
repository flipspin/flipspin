/** Visual review of real pages, with wire fixtures supplied by Playwright. */
import { createRoot } from 'react-dom/client';
import { useRef } from 'react';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import '@fontsource/jetbrains-mono/400.css';
import '../src/ui/tokens/app.css';
import '../src/ui/overlay.css';
import '../src/index.css'
import '../src/ui/buttons.css';
import '../src/i18n';
import { AudioPlayerProvider } from '../src/state/AudioPlayerContext';
import { SettingsProvider } from '../src/state/SettingsContext';
import { StatusProvider } from '../src/state/StatusContext';
import { DataProvider } from '../src/data';
import { UiProvider } from '../src/ui';
import { setFakeBridgeForTest } from '../src/bridge';
import type { KrobiBridge } from '../src/lib/ipc';
import AlbumPage from '../src/browse/AlbumPage';
import PlaylistPage from '../src/browse/PlaylistPage';
import LibraryAlbumPage from '../src/albums/LibraryAlbumPage';
import PlaylistHero from '../src/playlists/PlaylistHero';
import LibraryToolbar from '../src/albums/LibraryToolbar';
import AlbumTrackRow from '../src/albums/AlbumTrackRow';
import SongTableHeader from '../src/library/tracks/SongTableHeader';
import { useLibraryView } from '../src/albums/hooks/useLibraryView';
import { useLibraryScope } from '../src/albums/hooks/useLibraryScope';
import { setLibraryRoot } from '../src/lib/libraryKeys';
import { OfflineLibraryProvider } from '../src/offline/OfflineLibrary';
import { OfflineBanner } from '../src/offline/OfflineBanner';

const fixture = JSON.parse(new URL(location.href).searchParams.get('fixture'));
document.documentElement.dataset.mode = fixture.mode;
document.documentElement.dataset.theme = 'paper';
setLibraryRoot('/music');
setFakeBridgeForTest({
  invoke: (async (channel, request) => {
    if (channel === 'server:get-status') return { connection: { state: 'connected' } };
    if (channel === 'app:get-backend-origin') return { origin: 'http://acquire-fixture.test' };
    if (channel === 'offline:mode') return { forced: fixture.page === 'offline-library' };
    if (channel === 'offline:outbox') return [];
    if (channel === 'offline:sync') return { ok: true };
    if (channel === 'offline:snapshot') return fixture.page !== 'offline-library' ? undefined : { kind: request.kind, fetchedAt: 1794268800, body: JSON.stringify(request.kind === 'listing' ? [fixture.album] : { tracks: fixture.album.tracks.map(track => ({ relPath: track.relPath, fileExists: true })), count: fixture.album.tracks.length }) };
    if (channel === 'offline:status') return { tracks: fixture.offline || [], files: 0, bytes: 0, pins: 0 };
    if (channel === 'offline:pin') return { ok: true, pinId: 'album:42' };
    if (channel === 'log:write') return;
    throw new Error(`Unexpected bridge channel ${channel}`);
  }) as KrobiBridge['invoke'], on: () => () => {},
});
function Library() {
  const view = useLibraryView([fixture.album]);
  const scope = useLibraryScope(view.tracks, view.sortedAlbums);
  const searchRef = useRef<HTMLInputElement>(null);
  return <><h1 style={{ fontWeight: 800, fontSize: 28, marginBottom: 20 }}>Biblioteca</h1><div className="retro-song-table bg-panel border-2 border-black rounded-xl overflow-clip">
    <LibraryToolbar view={view} {...scope} onScope={scope.setScope} onGone={() => scope.setOnlyGone(!scope.onlyGone)} reloading={false} onReload={() => {}} searchRef={searchRef} />
    <SongTableHeader sortField="title" sortDir="asc" onSort={() => {}} />
    <ul className="retro-song-table__body">{scope.tracks.map((track, i) => <AlbumTrackRow key={track.path} track={track} album={fixture.album} index={i} onPlay={() => {}} />)}</ul>
  </div></>;
}
function Page() {
  if (['library', 'offline-library'].includes(fixture.page)) return <OfflineLibraryProvider albums={[fixture.album]}><OfflineBanner /><Library /></OfflineLibraryProvider>;
  if (fixture.page === 'library-album') return <LibraryAlbumPage id={fixture.album.path} albums={[fixture.album]} />;
  if (fixture.page === 'library-playlist') return <><PlaylistHero playlist={{ id: 'paper', name: 'Tarde de papel', cover: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="200" height="200"%3E%3Crect width="200" height="200" fill="%234F9C8B"/%3E%3C/svg%3E' }} tracks={fixture.album.tracks} /><ul className="retro-song-table">{fixture.album.tracks.map((track, i) => <AlbumTrackRow key={track.path} track={track} album={fixture.album} index={i} onPlay={() => {}} />)}</ul></>;
  if (fixture.page === 'playlist') return <PlaylistPage provider="deezer" id="42" />;
  return <AlbumPage provider="deezer" id="42" />;
}
createRoot(document.getElementById('root')).render(<UiProvider><DataProvider><SettingsProvider><StatusProvider><AudioPlayerProvider><main style={{ background: 'var(--paper)', color: 'var(--ink)', minHeight: '100vh', padding: 28 }}><Page /></main></AudioPlayerProvider></StatusProvider></SettingsProvider></DataProvider></UiProvider>);
