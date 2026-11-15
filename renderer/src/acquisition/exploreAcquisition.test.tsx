import { render } from "../library/tracks/songMenuTestSupport";
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentType } from 'react';
import { setFakeBridgeForTest } from '../bridge';
import type { KrobiBridge, OfflineTrackStatus } from '../lib/ipc';
import { refreshOffline } from './offline';
import { useAcquisition } from '../browse/useAcquisition';
import { TrackList as UntypedTrackList } from '../browse/TrackList';
import CollectionActions from './CollectionActions';
import type { AcquisitionItem, AcquisitionRequest, CatalogTrack } from './api';

const fixture = vi.hoisted(() => ({
  person: { status: 'ready', me: { id: 'account', source: 'token', role: 'member' } },
  library: { byRelPath: {} as Record<string, unknown> },
  ownership: vi.fn(),
  search: vi.fn(),
}));
vi.mock('@state/identityStore', () => ({
  useIdentity: () => fixture.person, getState: () => fixture.person,
  isRealUser: () => true, subscribe: () => () => {},
}));
vi.mock('@state/userLibraryStore', () => ({
  useUserLibrary: () => fixture.library, getState: () => fixture.library,
  relPathOf: track => track?.relPath || null,
  optimisticLibrary: keys => {
    fixture.library.byRelPath = { ...fixture.library.byRelPath, ...Object.fromEntries(keys.map(key => [key, { relPath: key }])) };
    return () => {};
  }, libraryWriteSettled: vi.fn(),
}));
vi.mock('../connection/connection', () => ({ useConnection: () => ({ state: 'connected' }), connectionStore: { getSnapshot: () => ({ kind: 'no-bridge' }) } }));
vi.mock('../offline/useOffline', () => ({ useOffline: () => false, useLocalCopies: () => new Set() }));
vi.mock('../browse/browseApi', () => ({ checkOwnership: fixture.ownership }));
vi.mock('@state/AudioPlayerContext', () => ({ useAudioPlayer: () => ({ setQueueWithTracks: vi.fn() }) }));
vi.mock('../state/useStatus', () => ({ useStatus: () => ({ showSuccess: vi.fn(), showError: vi.fn() }) }));

vi.mock('../data', async importOriginal => ({
  ...(await importOriginal<typeof import('../data')>()), apiPost: fixture.search,
}));

const TrackList = UntypedTrackList as unknown as ComponentType<Record<string, unknown>>;
const tracks: CatalogTrack[] = ['Repeat', 'Repeat', 'Third', 'Fourth', 'Fifth'].map((title, i) => ({
  title, artistName: 'Artist', albumTitle: 'Album', trackPosition: i + 1, ref: { provider: 'catalog', id: `track-${i}` },
}));
const identity = { kind: 'album' as const, provider: 'catalog', provider_id: 'album', title: 'Album' };
const initial = (): AcquisitionRequest => ({
  ...identity, id: 'request', state: 'approved', expected_tracks: tracks.length, imported_tracks: 0,
  tracks: tracks.map(track => ({ title: track.title, artist: track.artistName, album: track.albumTitle, provider_id: track.ref.id, track_number: track.trackPosition })),
});
const item = (index: number, stage: string, state: string, detail: AcquisitionItem['detail'] = {}, reason: string | null = null): AcquisitionItem => ({
  idx: stage === 'import' || stage === 'link' ? 0 : index, item: tracks[index].title, stage, state, reason, detail: { index, ...detail },
});
// Deliberately SQL/alphabetical stage order: request receipts come last.
const receipts = () => tracks.map((_, index) => item(index, 'request', 'done'));
const linked = (index: number) => item(index, 'link', 'done', { rel_path: `Album/${index}.mp3` });
let snapshot: AcquisitionRequest;
let submitted: AcquisitionRequest;
let reads: number;
let failPoll: boolean;
let files: OfflineTrackStatus[];
let invoke: ReturnType<typeof vi.fn>;
let restore: () => void;
let extraSnapshot: AcquisitionRequest | null;
let posts: { path: string; body: Record<string, unknown> }[];
let refuseRetry: boolean;
function Album({ collectionTracks = tracks }: { collectionTracks?: CatalogTrack[] }) {
  const acquisition = useAcquisition(undefined, identity);
  return <>
    <CollectionActions kind="album" refId="album" provider="catalog" title="Album" tracks={collectionTracks} catalog verdicts={[]} acquisition={acquisition} />
    <button onClick={() => void acquisition.cancel()}>Cancel</button>
    <TrackList tracks={tracks} acquisition={acquisition} acquiring={acquisition.active} onAcquire={track => acquisition.acquire([track])} />
  </>;
}
const row = (index: number) => screen.getAllByRole('listitem')[index];
const pins = () => invoke.mock.calls.filter(([channel]) => channel === 'offline:pin');
const appendedKeys = () => pins().filter(([, body]) => body.mode === 'append').flatMap(([, body]) => body.tracks.map(track => track.key));
async function poll() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
}
async function start(collectionTracks = tracks) {
  const view = render(<Album collectionTracks={collectionTracks} />);
  await act(async () => {});
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Descargar' })); });
  return view;
}
beforeEach(async () => {
  fixture.person.me.role = 'member';
  snapshot = initial(); submitted = initial(); reads = 0; failPoll = false; files = [];
  extraSnapshot = null; posts = []; refuseRetry = false;
  fixture.library.byRelPath = {};
  fixture.ownership.mockResolvedValue(tracks.map(() => ({ owned: false })));
  invoke = vi.fn(async (channel, body) => {
    if (channel === 'offline:status') return { tracks: files.filter(file => body.keys.includes(file.key)) };
    if (channel === 'offline:pin') return { ok: true, pinId: 'album:album' };
    return {};
  });
  restore = setFakeBridgeForTest({ invoke, on: () => () => {} } as KrobiBridge);
  await refreshOffline();
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (init.method === 'POST') posts.push({ path, body });
    if (path === '/api/acquisition/requests' && !init.method) return Response.json({ requests: [] });
    if (path === '/api/acquisition/requests' && init.method === 'POST') {
      if (body.kind === 'song') {
        extraSnapshot = { ...body, id: 'solo', state: 'fetching', expected_tracks: 1, imported_tracks: 0,
          items: [item(0, 'match', 'running')] };
        return Response.json(extraSnapshot);
      }
      return Response.json(submitted);
    }
    if (path.endsWith('/retry')) {
      if (refuseRetry) return Response.json({ detail: 'cannot-retry' }, { status: 409 });
      snapshot = { ...snapshot, state: 'approved', items: [...snapshot.items.filter(entry => entry.detail.index !== body.index), item(body.index, 'match', 'running')] };
      return Response.json({ ...snapshot, items: undefined, tracks: undefined });
    }
    if (path === '/api/acquisition/requests/solo') return Response.json(extraSnapshot);
    if (path.endsWith('/cancel')) { snapshot = { ...snapshot, state: 'rechazado' }; return Response.json(snapshot); }
    if (path === '/api/acquisition/requests/request') {
      reads++;
      if (failPoll) throw new Error('temporary disconnect');
      return Response.json(snapshot);
    }
    return Response.json({});
  }));
});
afterEach(() => { restore(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('Browse acquisition ledger and device continuation', () => {
  it('keeps one device icon with no overflow and offers the ordered removal actions on right-click', async () => {
    fixture.person.me.role = 'owner';
    fixture.library.byRelPath = { 'Album/0.mp3': { relPath: 'Album/0.mp3' } };
    fixture.ownership.mockResolvedValue(tracks.map((_track, index) => index === 0
      ? { owned: true, match: { path: '/music/Album/0.mp3', relPath: 'Album/0.mp3' } } : { owned: false }));
    files = [{ key: 'Album/0.mp3', state: 'descargado', pool: 'offline', bytes: 40, etag: null,
      verifiedAt: 1, lastPlayedAt: null, error: null }];
    render(<Album />);
    // Ownership and the device snapshot arrive through separate async boundaries.
    await waitFor(() => expect(within(row(0)).getByRole('button', { name: 'Quitar descarga' })).toBeVisible(), { timeout: 4000 });
    expect(within(row(0)).queryByRole('button', { name: 'Más opciones' })).toBeNull();
    expect(row(0).querySelectorAll('.acquire-row-end svg')).toHaveLength(1);
    fireEvent.contextMenu(row(0));
    expect(screen.getAllByRole('menuitem').slice(-3).map(item => item.textContent)).toEqual([
      'Quitar descarga', 'Quitar de mi biblioteca', 'Eliminar archivo del nido…',
    ]);
  });
  it('keeps an animated ring from acquisition through a delayed append and a publication 404', async () => {
    const original = invoke.getMockImplementation() as KrobiBridge['invoke'];
    let finishAppend: () => void;
    invoke.mockImplementation(async (channel, body) => {
      if (channel === 'offline:pin' && body.mode === 'append') {
        await new Promise<void>(resolve => { finishAppend = resolve; });
        files = [{ key: body.tracks[0].key, state: 'en fila', pool: 'offline', bytes: 0, etag: null,
          verifiedAt: null, lastPlayedAt: null, error: 'remote-file-missing' }];
      }
      return original(channel, body);
    });
    snapshot = { ...initial(), state: 'fetching', items: [item(0, 'fetch', 'running', { percent: 75 }), ...receipts()] };
    await start();
    expect(within(row(0)).getByRole('img', { name: 'Agregando · 75 %' })).toBeVisible();
    // Finished fetch retains its animated acquisition ring until link lands.
    snapshot = { ...snapshot, items: [item(0, 'fetch', 'done', { percent: 100 }), ...receipts()] };
    await poll();
    expect(within(row(0)).getByRole('img', { name: 'Agregando' }).querySelector('.animate-spin')).toBeInTheDocument();
    snapshot = { ...snapshot, imported_tracks: 1, items: [linked(0), ...receipts()] };
    await poll();
    expect(within(row(0)).getByRole('img', { name: 'Descargando' }).querySelector('.animate-spin')).toBeInTheDocument();
    expect(row(0).querySelector('.lucide-file-x, .lucide-plus, .is-failed, .acquire-progress')).toBeNull();
    await act(async () => { finishAppend(); });
    await act(refreshOffline);
    expect(within(row(0)).getByRole('img', { name: 'Descargando' }).querySelector('.animate-spin')).toBeInTheDocument();
    expect(row(0).querySelector('.lucide-file-x, .lucide-plus')).toBeNull();
    files = files.map(file => ({ ...file, state: 'descargado', verifiedAt: 1, error: null }));
    await act(refreshOffline);
    expect(within(row(0)).getByRole('button', { name: 'Quitar descarga' }).querySelector('.lucide-check')).toBeInTheDocument();
  });
  it('keeps a manually chosen result in its album row and device-download continuation', async () => {
    const siblings = [0, 2, 3, 4];
    const failure = item(1, 'match', 'failed', {}, 'no-encontrada');
    snapshot = { ...initial(), state: 'fetching', imported_tracks: 4, items: [failure, ...siblings.map(linked), ...receipts()] };
    fixture.search.mockResolvedValue({ query: 'Repeat Artist audio', results: [
      { id: 'chosen', url: 'https://www.youtube.com/watch?v=chosen', title: 'Chosen recording', duration: 200, uploader: 'Artist' },
    ] });
    await start();
    await poll();
    expect(posts.map(post => post.path)).toEqual(['/api/acquisition/requests']);
    expect(fixture.search).not.toHaveBeenCalled();
    const action = within(row(1)).getByRole('button', { name: 'No se encontró' });
    expect(action.querySelector('.lucide-search')).toBeInTheDocument();
    await act(async () => { fireEvent.click(action); });
    const modal = within(screen.getByRole('dialog', { name: 'Buscar de otra forma' }));
    expect(modal.getByRole('textbox', { name: 'Buscar en YouTube' })).toHaveValue('Repeat Artist audio');
    expect(posts).toHaveLength(1);
    expect(fixture.search).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(modal.getByRole('button', { name: 'Buscar' })); });
    expect(fixture.search).toHaveBeenCalledWith('/api/downloads/youtube-search', { body: { query: 'Repeat Artist audio', limit: 10 } });
    await act(async () => { fireEvent.click(modal.getByRole('button', { name: 'Descargar' })); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(posts).toHaveLength(1);
    expect(within(row(1)).getByRole('img', { name: 'En fila' })).toBeVisible();
    snapshot = { ...snapshot, state: 'parcial' };
    await poll();
    expect(posts[1]).toEqual({ path: '/api/acquisition/requests/request/retry', body: { index: 1, youtube_url: 'https://www.youtube.com/watch?v=chosen' } });
    expect(appendedKeys()).toEqual(siblings.map(index => `Album/${index}.mp3`));
    snapshot = { ...snapshot, state: 'completo', imported_tracks: 5, items: [...tracks.map((_, index) => linked(index)), ...receipts()] };
    await poll();
    expect(pins().filter(([, body]) => body.mode === 'ensure')).toHaveLength(1);
    expect(appendedKeys()).toEqual([...siblings, 1].map(index => `Album/${index}.mp3`));
    expect(pins()).toHaveLength(tracks.length + 1);
    await poll();
    expect(posts.filter(post => post.path.endsWith('/retry'))).toHaveLength(1);
    expect(pins()).toHaveLength(tracks.length + 1);
    expect(within(row(1)).getByRole('button', { name: 'Descargar en este equipo' })).toBeVisible();
  });

  it.each(['no-encontrada', 'fallo-descarga'])('does not retry a terminal %s item without a press', async reason => {
    snapshot = { ...initial(), state: 'parcial', imported_tracks: 4, items: [item(1, 'fetch', 'failed', {}, reason), ...[0, 2, 3, 4].map(linked), ...receipts()] };
    submitted = snapshot;
    await start();
    await poll(); await poll();
    expect(posts.filter(post => post.path.endsWith('/retry'))).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('downloads in landing order while siblings fetch, skips failures, and appends a late retry once', async () => {
    const original = invoke.getMockImplementation() as KrobiBridge['invoke'];
    invoke.mockImplementation(async (channel, body) => {
      if (channel === 'offline:pin' && body.mode === 'append') {
        files.push(...body.tracks.map(track => ({ key: track.key, state: 'en fila', pool: 'offline', bytes: 0, etag: null, verifiedAt: null, lastPlayedAt: null, error: null })));
      }
      return original(channel, body);
    });
    snapshot = { ...initial(), state: 'fetching', items: [
      item(2, 'match', 'running'), item(0, 'fetch', 'running', { percent: 18 }),
      item(1, 'fetch', 'failed', { error: 'source refused' }, 'fallo-descarga'), ...receipts(),
    ] };
    await start();
    expect(pins()).toEqual([['offline:pin', { kind: 'album', ref: 'album', mode: 'ensure', tracks: [] }]]);
    expect(within(row(2)).getByRole('img', { name: 'Buscando' })).toBeVisible();
    snapshot = { ...snapshot, items: [item(2, 'fetch', 'running', { percent: 52 }), item(0, 'fetch', 'running', { percent: 18 }), ...receipts()] };
    await poll();
    expect(within(row(2)).getByRole('img', { name: 'Agregando · 52 %' })).toBeVisible();
    expect(appendedKeys()).toEqual([]);
    snapshot = { ...snapshot, imported_tracks: 1, items: [linked(2), item(0, 'fetch', 'running', { percent: 18 }), ...receipts()] };
    await poll();
    expect(appendedKeys()).toEqual(['Album/2.mp3']);
    expect(within(row(2)).getByRole('img', { name: 'Descargando' })).toBeVisible();
    expect(within(row(0)).getByRole('img', { name: 'Agregando · 18 %' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Agregando 1 / 5' })).toBeVisible();
    files = files.map(file => ({ ...file, state: 'descargado' }));
    await act(refreshOffline);
    expect(within(row(2)).getByRole('button', { name: 'Quitar descarga' }).querySelector('.lucide-check')).toBeInTheDocument();
    snapshot = { ...snapshot, state: 'parcial', imported_tracks: 2, items: [
      linked(0), linked(2), ...[1, 3, 4].map(index => item(index, 'fetch', 'failed', { error: 'source refused' }, 'fallo-descarga')), ...receipts(),
    ] };
    await poll();
    expect(appendedKeys()).toEqual(['Album/2.mp3', 'Album/0.mp3']);
    expect(within(row(0)).getByRole('img', { name: 'Descargando' })).toBeVisible();
    await act(async () => { fireEvent.click(within(row(1)).getByRole('button', { name: 'Reintentar «Repeat»' })); });
    await poll();
    snapshot = { ...snapshot, state: 'parcial', imported_tracks: 3, items: [
      ...[0, 1, 2].map(linked), linked(4), ...[3, 4].map(index => item(index, 'fetch', 'failed', { error: 'source refused' }, 'fallo-descarga')), ...receipts(),
    ] };
    await poll(); await poll();
    expect(appendedKeys()).toEqual(['Album/2.mp3', 'Album/0.mp3', 'Album/1.mp3']);
    expect(within(row(1)).getByRole('img', { name: 'Descargando' })).toBeVisible();
    expect(pins().filter(([, body]) => body.mode === 'ensure')).toHaveLength(1);
  });

  it('keeps a downloaded song on cancellation and ignores newly linked siblings in the cancel response', async () => {
    await start();
    snapshot = { ...initial(), state: 'fetching', imported_tracks: 1, items: [linked(2), item(0, 'fetch', 'running'), ...receipts()] };
    await poll();
    files = [{ key: 'Album/2.mp3', state: 'descargado', pool: 'offline', bytes: 0, etag: null, verifiedAt: null, lastPlayedAt: null, error: null }];
    await act(refreshOffline);
    snapshot = { ...snapshot, imported_tracks: 2, items: [linked(0), linked(2), ...receipts()] };
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    await poll();
    expect(appendedKeys()).toEqual(['Album/2.mp3']);
    expect(invoke.mock.calls.some(([channel]) => channel === 'offline:unpin')).toBe(false);
    expect(within(row(2)).getByRole('button', { name: 'Quitar descarga' })).toBeVisible();
  });

  it('discards queued pin continuations when cancellation overtakes an in-flight append', async () => {
    const original = invoke.getMockImplementation() as KrobiBridge['invoke'];
    let finishPin: () => void;
    invoke.mockImplementation(async (channel, body) => {
      if (channel === 'offline:pin' && body.mode === 'append' && body.tracks[0].key === 'Album/0.mp3') {
        return new Promise(resolve => { finishPin = () => resolve({ ok: true, pinId: 'album:album' }); });
      }
      return original(channel, body);
    });
    await start();
    snapshot = { ...initial(), state: 'fetching', imported_tracks: 2, items: [linked(0), linked(2), ...receipts()] };
    await poll();
    expect(appendedKeys()).toEqual(['Album/0.mp3']);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    await act(async () => { finishPin(); });
    await poll();
    expect(appendedKeys()).toEqual(['Album/0.mp3']);
    expect(screen.getByRole('button', { name: 'Descargar' })).toBeEnabled();
  });

  it.each(['completo', 'parcial'])('keeps sibling states and pins landed siblings before the %s retry finishes', async state => {
    snapshot = { ...initial(), state: 'fetching', imported_tracks: 1, items: [
      item(0, 'fetch', 'failed', { error: 'source refused' }, 'fallo-descarga'),
      item(1, 'match', 'running'), item(2, 'fetch', 'running', { percent: 42 }),
      linked(3), item(4, 'fetch', 'queued'), ...receipts(),
    ] };
    await start();
    const action = within(row(0)).getByRole('button', { name: 'Reintentar «Repeat»' });
    expect(action).toHaveAttribute('title', 'Falló la descarga');
    expect(action).toHaveClass('is-retry');
    expect(row(0).querySelectorAll('.acquire-row-end svg')).toHaveLength(1);
    expect(row(0).querySelector('.lucide-plus')).toBeNull();
    await act(async () => { fireEvent.click(action); });
    expect(posts).toHaveLength(1);
    expect(within(row(0)).getByRole('img', { name: 'En fila' })).toBeVisible();
    expect(within(row(1)).getByRole('img', { name: 'Buscando' })).toBeVisible();
    expect(within(row(2)).getByRole('img', { name: 'Agregando · 42 %' })).toBeVisible();
    expect(within(row(3)).getByRole('button', { name: 'Descargar en este equipo' })).toBeVisible();
    expect(within(row(4)).getByRole('img', { name: 'En fila' })).toBeVisible();
    for (let index = 0; index < tracks.length; index++) expect(row(index).querySelector('.lucide-plus')).toBeNull();

    // The first attempt ends. Its successes download while the queued retry
    // uses the same request and manifest index.
    const siblings = state === 'completo' ? [1, 2, 3, 4] : [1, 2, 3];
    const remaining = state === 'parcial' ? [item(4, 'fetch', 'failed', { error: 'source refused' }, 'fallo-descarga')] : [];
    snapshot = { ...snapshot, state: 'parcial', imported_tracks: siblings.length, items: [
      item(0, 'fetch', 'failed', { error: 'source refused' }, 'fallo-descarga'), ...siblings.map(linked), ...remaining, ...receipts(),
    ] };
    await poll();
    expect(posts).toHaveLength(2);
    expect(posts[1]).toEqual({ path: '/api/acquisition/requests/request/retry', body: { index: 0 } });
    expect(appendedKeys()).toEqual([3, ...siblings.filter(index => index !== 3)].map(index => `Album/${index}.mp3`));
    // Fresh stages can be allocated before the server relinks prior successes.
    snapshot = { ...snapshot, items: [item(0, 'match', 'running'), ...siblings.map(index => item(index, 'link', 'queued')), ...remaining] };
    await poll();
    expect(within(row(0)).getByRole('img', { name: 'Buscando' })).toBeVisible();
    for (const index of siblings) expect(within(row(index)).getByRole('button', { name: 'Descargar en este equipo' })).toBeVisible();
    const landed = state === 'completo' ? [0, 1, 2, 3, 4] : [0, 1, 2, 3];
    snapshot = { ...snapshot, state, imported_tracks: landed.length, items: [
      ...landed.map(linked), ...(state === 'parcial' ? [item(4, 'fetch', 'failed', { error: 'source refused' }, 'fallo-descarga')] : []), ...receipts(),
    ] };
    fixture.ownership.mockResolvedValue(tracks.map((_track, index) => ({ owned: landed.includes(index), match: { relPath: `Album/${index}.mp3` } })));
    await poll();
    expect(pins()).toHaveLength(landed.length + 1);
    expect(appendedKeys()).toEqual([3, ...siblings.filter(index => index !== 3), 0].map(index => `Album/${index}.mp3`));
    expect(fixture.ownership).toHaveBeenCalledTimes(2);
    files = landed.map(index => ({ key: `Album/${index}.mp3`, state: 'descargado', pool: 'offline', bytes: 0, etag: null, verifiedAt: null, lastPlayedAt: null, error: null }));
    await act(refreshOffline);
    for (const index of landed) expect(within(row(index)).getByRole('button', { name: 'Quitar descarga' })).toBeVisible();
    await poll(); await poll();
    expect(pins()).toHaveLength(landed.length + 1);
  });

  it('watches a separate song request without losing the album ledger or its download intent', async () => {
    const subset = tracks.slice(0, 4);
    submitted = { ...initial(), expected_tracks: 4, tracks: initial().tracks.slice(0, 4) };
    snapshot = { ...submitted, state: 'fetching', items: [item(0, 'match', 'running'), item(1, 'fetch', 'running', { percent: 33 }), linked(2), item(3, 'fetch', 'queued')] };
    await start(subset);
    await act(async () => { fireEvent.click(within(row(4)).getByRole('button', { name: 'Agregar «Fifth»' })); });
    expect(posts).toHaveLength(2);
    expect(within(row(0)).getByRole('img', { name: 'Buscando' })).toBeVisible();
    expect(within(row(1)).getByRole('img', { name: 'Agregando · 33 %' })).toBeVisible();
    expect(within(row(2)).getByRole('button', { name: 'Descargar en este equipo' })).toBeVisible();
    expect(within(row(3)).getByRole('img', { name: 'En fila' })).toBeVisible();
    expect(within(row(4)).getByRole('img', { name: 'Buscando' })).toBeVisible();
    snapshot = { ...snapshot, state: 'completo', imported_tracks: 4, items: [0, 1, 2, 3].map(linked) };
    await poll();
    expect(pins()).toHaveLength(5);
    expect(appendedKeys()).toEqual([2, 0, 1, 3].map(index => `Album/${index}.mp3`));
    expect(within(row(4)).getByRole('img', { name: 'Buscando' })).toBeVisible();
    extraSnapshot = { ...extraSnapshot, state: 'completo', imported_tracks: 1, items: [{ ...linked(4), detail: { index: 0, rel_path: 'Album/4.mp3' } }] };
    await poll();
    expect(within(row(4)).getByRole('button', { name: 'Descargar en este equipo' })).toBeVisible();
    expect(fixture.ownership).toHaveBeenCalledTimes(3);
    await poll();
    expect(pins()).toHaveLength(5);
  });

  it('releases the album continuation if an item retry is refused', async () => {
    snapshot = { ...initial(), state: 'fetching', items: [item(0, 'fetch', 'failed', { error: 'source refused' }, 'fallo-descarga'), item(1, 'match', 'running'), ...receipts()] };
    await start();
    await act(async () => { fireEvent.click(within(row(0)).getByRole('button', { name: 'Reintentar «Repeat»' })); });
    refuseRetry = true;
    snapshot = { ...snapshot, state: 'parcial', imported_tracks: 4, items: [item(0, 'fetch', 'failed', { error: 'source refused' }, 'fallo-descarga'), ...[1, 2, 3, 4].map(linked), ...receipts()] };
    await poll();
    expect(appendedKeys()).toEqual([1, 2, 3, 4].map(index => `Album/${index}.mp3`));
    expect(within(row(0)).getByRole('button', { name: 'Reintentar «Repeat»' })).toBeEnabled();
    expect(fixture.ownership).toHaveBeenCalledTimes(2);
  });

  it('hands completed receipts back to current library membership', async () => {
    const view = await start();
    snapshot = { ...initial(), state: 'completo', imported_tracks: 5, items: tracks.map((_, index) => linked(index)) };
    await poll();
    expect(pins()).toHaveLength(6);
    // The mocked library has no subscription; rerender when its load lands.
    await act(async () => { view.rerender(<Album />); });
    fixture.library.byRelPath = {};
    await act(async () => { view.rerender(<Album />); });
    expect(within(row(1)).getByRole('button', { name: 'Agregar «Repeat»' })).toBeVisible();
  });

  it('does not treat historical receipts as current library membership', async () => {
    const request = { ...initial(), state: 'completo', items: [...tracks.map((_, i) => linked(i)), ...receipts()] };
    const acquisition = { requests: undefined, retainedIds: new Set<string>(), ownershipRevision: 0, retryItem: vi.fn(), request, active: false, total: 5, completed: 5, error: null, acquire: vi.fn(), retry: vi.fn(), cancel: vi.fn() };
    render(<>
      <CollectionActions kind="album" refId="album" title="Album" tracks={tracks} catalog verdicts={[]} acquisition={acquisition} />
      <TrackList tracks={tracks} acquisition={acquisition} onAcquire={vi.fn()} />
    </>);
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Agregar' })).toBeEnabled();
    expect(within(row(0)).getByRole('button', { name: 'Agregar «Repeat»' })).toBeEnabled();
    expect(within(row(0)).queryByRole('img', { name: 'En fila' })).toBeNull();
  });

  it('hydrates a reordered subset with duplicate titles and keeps the running matcher visible', async () => {
    const request = initial();
    request.expected_tracks = 2;
    request.tracks = [request.tracks[1], request.tracks[0]];
    request.items = [item(0, 'request', 'done'), item(1, 'request', 'done'),
      item(0, 'fetch', 'queued'), item(0, 'match', 'running'),
      item(1, 'fetch', 'running', { percent: 81 })];
    render(<TrackList tracks={tracks} acquisition={{ request, active: true }} onAcquire={vi.fn()} />);
    await act(async () => {});
    expect(within(row(0)).getByRole('img', { name: 'Agregando · 81 %' })).toBeVisible();
    expect(within(row(1)).getByRole('img', { name: 'Buscando' })).toBeVisible();
    expect(within(row(2)).queryByRole('img')).toBeNull();
    expect(within(row(2)).getByRole('button', { name: 'Agregar «Third»' })).toBeEnabled();
  });

  it('maps duplicate titles by manifest identity, selects stages, and advances each row over polls', async () => {
    snapshot = { ...initial(), state: 'fetching', imported_tracks: 1, items: [
      item(0, 'fetch', 'queued'), item(1, 'fetch', 'running', { percent: 37 }),
      item(2, 'import', 'done'), item(3, 'fetch', 'failed', { error: 'source refused' }, 'fallo-descarga'),
      item(4, 'fetch', 'queued'), item(0, 'match', 'done', { decision: 'STRONG' }),
      item(1, 'match', 'done', { decision: 'STRONG' }), ...receipts(),
    ] };
    await start();
    expect(within(row(0)).getByRole('img', { name: 'Agregando' })).toBeVisible();
    expect(within(row(1)).getByRole('img', { name: 'Agregando · 37 %' })).toBeVisible();
    expect(within(row(2)).getByRole('button', { name: 'Descargar en este equipo' })).toHaveClass('is-download');
    expect(within(row(3)).getByRole('img', { name: 'Falló la descarga' })).toBeVisible();
    expect(within(row(4)).getByRole('img', { name: 'En fila' })).toBeVisible();
    expect(row(0).querySelector('.lucide-plus')).toBeNull();
    expect(row(1).querySelector('.lucide-plus')).toBeNull();
    expect(screen.getByRole('button', { name: 'Agregando 1 / 5' })).toBeVisible();
    snapshot = { ...snapshot, imported_tracks: 2, items: [item(0, 'fetch', 'running', { percent: 62 }), item(1, 'import', 'done'), item(2, 'import', 'done'), item(3, 'fetch', 'failed', { error: 'source refused' }), item(4, 'fetch', 'queued'), ...receipts()] };
    await poll();
    expect(within(row(0)).getByRole('img', { name: 'Agregando · 62 %' })).toBeVisible();
    expect(within(row(1)).getByRole('button', { name: 'Descargar en este equipo' })).toHaveClass('is-download');
    expect(screen.getByRole('button', { name: 'Agregando 2 / 5' })).toBeVisible();
    expect(appendedKeys()).toEqual([]);
  });

  it('keeps each row fetching through publication, then added while other songs still fetch', async () => {
    const stages = () => tracks.flatMap((_, index) => [item(index, 'import', 'queued'), item(index, 'link', 'queued')]);
    snapshot = { ...initial(), state: 'fetching', items: [...tracks.map((_, i) => item(i, 'fetch', 'queued')), ...stages(), ...receipts()] };
    await start();
    expect(within(row(1)).getByRole('img', { name: 'En fila' })).toBeVisible();
    snapshot = { ...snapshot, items: [item(1, 'fetch', 'running', { percent: 52 }), item(2, 'fetch', 'running'), ...stages(), ...receipts()] };
    await poll();
    expect(within(row(1)).getByRole('img', { name: 'Agregando · 52 %' })).toBeVisible();
    snapshot = { ...snapshot, items: [item(1, 'fetch', 'done'), item(2, 'fetch', 'running'), ...stages(), ...receipts()] };
    await poll();
    expect(within(row(1)).getByRole('img', { name: 'Agregando' })).toBeVisible();
    expect(within(row(1)).queryByRole('img', { name: 'En fila' })).toBeNull();
    snapshot = { ...snapshot, state: 'importing', items: [item(1, 'fetch', 'done'), item(1, 'import', 'done'), item(1, 'link', 'queued'), item(2, 'fetch', 'running'), ...receipts()] };
    await poll();
    expect(within(row(1)).getByRole('img', { name: 'Agregando' })).toBeVisible();
    expect(within(row(1)).queryByRole('button', { name: 'Descargar en este equipo' })).toBeNull();
    snapshot = { ...snapshot, imported_tracks: 1, items: [item(1, 'fetch', 'done'), item(1, 'import', 'done'), linked(1), item(2, 'fetch', 'running'), ...receipts()] };
    await poll();
    expect(within(row(1)).getByRole('button', { name: 'Descargar en este equipo' })).toHaveClass('is-download');
    expect(row(1).querySelector('.acquire-row-end').querySelectorAll('svg')).toHaveLength(1);
    expect(within(row(1)).queryByRole('img', { name: 'En fila' })).toBeNull();
    expect(within(row(2)).getByRole('img', { name: 'Agregando' })).toBeVisible();
    expect(appendedKeys()).toEqual(['Album/1.mp3']);
  });

  it.each(['completo', 'parcial'])('pins the landed songs exactly once on %s, even with stale ownership', async state => {
    await start();
    const landed = state === 'completo' ? [0, 1, 2, 3, 4] : [0, 2];
    snapshot = { ...initial(), state, imported_tracks: landed.length, items: [
      ...landed.map(linked),
      ...tracks.flatMap((_, index) => landed.includes(index) ? [] : [item(index, 'fetch', 'failed', { error: 'source refused' }, 'fallo-descarga')]),
      ...receipts(),
    ] };
    await poll();
    expect(pins()).toEqual([
      ['offline:pin', { kind: 'album', ref: 'album', mode: 'ensure', tracks: [] }],
      ...landed.map(index => ['offline:pin', { kind: 'album', ref: 'album', mode: 'append', tracks: [{ key: `Album/${index}.mp3`, inLibrary: true }] }]),
    ]);
    expect(fixture.ownership).toHaveBeenCalledTimes(2); // Refresh at completion; receipts bridge a stale ownership answer.
    if (state === 'parcial') expect(within(row(1)).getByRole('img', { name: 'Falló la descarga' })).toBeVisible();
    for (const deviceState of ['en fila', 'descargando', 'descargado'] as const) {
      files = landed.map(index => ({ key: `Album/${index}.mp3`, state: deviceState, pool: 'offline', bytes: 0, etag: null, verifiedAt: null, lastPlayedAt: null, error: null }));
      await act(refreshOffline);
      for (const index of landed) {
        const end = row(index).querySelector('.acquire-row-end');
        expect(end.querySelectorAll('svg')).toHaveLength(1);
        expect(end.querySelectorAll('.acquire-action-slot')).toHaveLength(1);
        if (deviceState === 'descargado') {
          expect(within(row(index)).getByRole('button', { name: 'Quitar descarga' }).querySelector('.lucide-check')).toBeInTheDocument();
        } else expect(within(row(index)).getByRole('img', { name: 'Descargando' })).toBeVisible();
      }
    }
    const stoppedAt = reads;
    await poll(); await poll();
    expect(reads).toBe(stoppedAt);
    expect(pins()).toHaveLength(landed.length + 1);
  });

  it('records intent immediately but does not attach songs from a cancelled request', async () => {
    await start();
    expect(pins()).toEqual([['offline:pin', { kind: 'album', ref: 'album', mode: 'ensure', tracks: [] }]]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    await poll();
    expect(appendedKeys()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Descargar' })).toBeEnabled();
  });

  it('does not reuse a previous completion while the next submission is pending', async () => {
    const acquire = vi.fn();
    let accept: (request: AcquisitionRequest) => void;
    acquire.mockImplementation(() => new Promise<AcquisitionRequest>(resolve => { accept = resolve; }));
    const acquisition = { requests: undefined, retainedIds: new Set<string>(), ownershipRevision: 0, retryItem: vi.fn(), request: { ...initial(), state: 'completo' }, active: false, total: 5, completed: 5, error: null, acquire, retry: vi.fn(), cancel: vi.fn() };
    const props = { kind: 'album' as const, refId: 'album', title: 'Album', tracks, catalog: true, verdicts: [] };
    const view = render(<CollectionActions {...props} acquisition={acquisition} />);
    fireEvent.click(screen.getByRole('button', { name: 'Descargar' }));
    await act(async () => {});
    expect(appendedKeys()).toEqual([]);
    const next = { ...initial(), id: 'next' };
    await act(async () => { accept(next); });
    view.rerender(<CollectionActions {...props} acquisition={{ ...acquisition, request: next, active: true }} />);
    expect(appendedKeys()).toEqual([]);
    view.rerender(<CollectionActions {...props} acquisition={{ ...acquisition, request: { ...next, state: 'completo', items: [...tracks.map((_, i) => linked(i)), ...receipts()] } }} />);
    await waitFor(() => expect(pins()).toHaveLength(6));
  });

  it('keeps the intent across a transient poll error', async () => {
    await start();
    failPoll = true; await poll();
    expect(screen.getByRole('button', { name: 'Descargando 0 / 5' })).toBeDisabled();
    failPoll = false;
    snapshot = { ...initial(), state: 'completo', imported_tracks: 5, items: [...tracks.map((_, i) => linked(i)), ...receipts()] };
    await poll();
    expect(pins()).toHaveLength(6);
  });

  it('handles immediate summary completion by reading its link receipts', async () => {
    submitted = { ...initial(), state: 'completo', imported_tracks: 5 };
    snapshot = { ...submitted, items: [...tracks.map((_, i) => linked(i)), ...receipts()] };
    render(<Album />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Descargar' }));
    await waitFor(() => expect(pins()).toHaveLength(6));
    expect(reads).toBe(1);
  });
});
