/** review harness. Real UI, isolated synthetic API; no nest requests. */
import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '../src/index.css'
import '../src/ui/buttons.css';
import '../src/i18n';
import { setFakeBridgeForTest } from '../src/bridge';
import { DataProvider } from '../src/data';
import { AudioPlayerProvider } from '../src/state/AudioPlayerContext';
import { AudioAnalyzerProvider } from '../src/state/AudioAnalyzerContext';
import { StatusProvider } from '../src/state/StatusContext';
import FixedBottomPlayerBar from '../src/player/FixedBottomPlayerBar';
import LibraryToolbar from '../src/albums/LibraryToolbar';
import { useLibraryView } from '../src/albums/hooks/useLibraryView';
import LyricsOverlay from '../src/lyrics/LyricsOverlay';
import { openLyrics } from '../src/lyrics/lyricsStore';
import { stemPlayer } from '../src/stems/StemPlayer';

// Match the app's persisted theme in this isolated harness (no SettingsProvider).
document.documentElement.dataset.mode = localStorage.getItem('krobi.mode') || 'light';
document.documentElement.dataset.theme = 'paper';

const scenario = new URLSearchParams(location.search).get('state') || 'ready';
const ready = ['ready', 'lyrics', 'filter'].includes(scenario);
const path = 'No Hay Loco Que No Corone/Cuando No Era Cantante.mp3';
const track = { path, title: 'Cuando No Era Cantante', artist: 'El Bogueto, Yung Beef', duration: 357, album: 'No Hay Loco Que No Corone' };
const split = { album: 'No Hay Loco Que No Corone', file: 'Cuando No Era Cantante.mp3', title: track.title, artist: track.artist, albumTitle: track.album, createdAt: new Date(Date.now() - 2 * 86400000).toISOString(), stale: false, sizeBytes: 34_000_000 };
const albums = [{ album: track.album, artist: track.artist, path: track.album, tracks: [track, { ...track, path: `${track.album}/EN LA PEDA.mp3`, title: 'EN LA PEDA', artist: 'Junior H', duration: 235 }, { ...track, path: `${track.album}/Un Desperdicio.mp3`, title: 'Un Desperdicio', artist: 'Rels B, Junior H', duration: 223 }] }];
let deleted = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  if (!url.pathname.startsWith('/api/')) return originalFetch(input, init);
  let status = 200, body: unknown = {};
  if (url.pathname === '/api/me') body = { isOwner: true, role: 'owner' };
  else if (url.pathname === '/api/stems') body = { splits: ready && !deleted ? [split] : [] };
  else if (url.pathname === '/api/stems/request') body = { status: 'queued' };
  else if (url.pathname.startsWith('/api/stems/')) {
    if (req.method === 'DELETE') { deleted = true; body = { removed: true }; }
    else if (ready && !deleted) body = { createdAt: split.createdAt, track: { duration: 357 }, stems: Object.fromEntries(['drums', 'bass', 'other', 'vocals'].map(s => [s, `/api/stems/fixture/song.mp3/${s}`])) };
    else if (scenario === 'separando') { status = 202; body = { status: 'running', phase: 'separating', progress: 62, agent: { online: true, name: 'MacBook Pro' } }; }
    else { status = 404; body = { detail: 'Not found' }; }
  } else if (url.pathname === '/api/lyrics/states') body = { states: {}, counts: { synced: 1, plain: 0, none: 2, pending: 0, instrumental: 0, queued: 0 } };
  else if (url.pathname === '/api/lyrics/jobs') body = { engine: { ready: false, mode: 'agent' }, pending: [], pendingCount: 0 };
  else if (url.pathname.startsWith('/api/lyrics/')) body = { relPath: path, text: '[00:43]Para darte esos besotes de aquellos\n[00:46]Como antes, baby, vamos a hacerlo como antes\n[00:51]Como cuando no era cantante\n[00:54]Antes de que yo me hiciera un cáncer\n[00:57]Mami, extraño tu olor, necesito tu calor', kind: 'synced', source: 'manual' };
  else { status = 404; }
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
};
setFakeBridgeForTest({ invoke: (async channel => {
  if (channel === 'app:get-backend-origin') return { origin: 'http://stems-fixture.test' };
  if (channel === 'auth:get') return { hasToken: false, userId: null, role: null };
  if (channel === 'server:get-status') return { instanceId: 'fixture' };
  if (channel === 'log:write') return;
  return null;
}) as never, on: () => () => {} });
localStorage.setItem('playerNowPlaying', JSON.stringify(track));
localStorage.setItem('krobi.bottomBarDrawerPage', 'Stems');
localStorage.setItem('krobi.bottomBarDrawerOpen', '1');
localStorage.setItem('krobi.lyricsBackdrop', 'solid');
if (scenario === 'lyrics') { stemPlayer.setPreset('karaoke'); openLyrics(path); }
else if (ready) {
  stemPlayer.reset();
  stemPlayer.setLevel('bass', 100 * 10 ** (2 / 20));
  stemPlayer.setLevel('other', 100 * 10 ** (-3.5 / 20));
  stemPlayer.setLevel('vocals', 100 * 10 ** (-12 / 20));
}
// eslint-disable-next-line react-refresh/only-export-components
function Harness() {
  const view = useLibraryView(albums);
  const searchRef = useRef<HTMLInputElement>(null);
  return <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--canvas)' }}>
    <main style={{ padding: '36px 44px', flex: 1 }}><h1 style={{ fontSize: 28, fontWeight: 700 }}>Biblioteca</h1>
      <LibraryToolbar view={view} searchRef={searchRef} scoped={false} canScope={false} onScope={() => {}} serverCount={3} mineCount={3} accountName="Fixture" reloading={false} onReload={() => {}} />
      <table style={{ width: '100%', marginTop: 16, borderCollapse: 'collapse', textAlign: 'left', fontSize: 14 }}><thead><tr><th>Canción</th><th>Artista</th><th>Álbum</th><th>Duración</th></tr></thead><tbody>{view.tracks.map(t => <tr key={t.path} style={{ height: 48, borderBottom: '1px solid #d8d2c6' }}><td>{t.title}</td><td>{t.artist}</td><td>{t.album.album}</td><td>05:57</td></tr>)}</tbody></table>
    </main><FixedBottomPlayerBar /><LyricsOverlay />
  </div>;
}
createRoot(document.getElementById('root')!).render(<DataProvider><StatusProvider><AudioAnalyzerProvider><AudioPlayerProvider><Harness /></AudioPlayerProvider></AudioAnalyzerProvider></StatusProvider></DataProvider>);
