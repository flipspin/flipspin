import { waitForClock } from '../test/test-clock';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, onlineManager, focusManager, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import appSource from '../shell/App.tsx?raw';
import type { ReactNode } from 'react';
import { DataProvider } from '../data/provider';
import { useLibraryAlbums } from '../data/hooks/use-library-albums';
import { useLibraryMissing } from '../data/hooks/use-library-missing';
import { queryKeys } from '../data/keys';
import { resetApiClient } from '../data/backend';
import { setFakeBridgeForTest } from '../bridge';
import { BRIDGE_KEY } from '../lib/ipc';
import { setForcedOffline } from '../offline/mode';
import { queryGet } from '../data/http';
import * as membershipStore from '@state/userLibraryStore';
import type { KrobiBridge, OfflineTrackStatus } from '../lib/ipc';
import { serverStatus } from '../settings/test-support';
import { getState, load, resetLibrary, useUserLibrary } from '@state/userLibraryStore';
import { announceLibraryChanged, announceLibraryJob, resetLibraryJobs } from '@lib/libraryEvents';
import { setLibraryRoot } from '@lib/libraryKeys';
import { UiProvider, dismissAllNotifications } from '../ui';
import { RowEnd } from '../acquisition/RowState';
import { removeLibrary, writeLibrary } from '../acquisition/libraryActions';
import { useLibraryScope } from '../albums/hooks/useLibraryScope';
import { reconcile, resetForIdentityChange, stopReconciling } from '../downloads/downloadsStore';
import { refreshAcquisitions } from '../downloads/acquisitionJobs';
import { push, reset as resetBrowse } from '../browse/navigationStore';
import App from '../shell/App';

const person = vi.hoisted(() => ({ status: 'ready', me: { id: 'ana', label: 'Ana', source: 'token', isOwner: false } }));
vi.mock('@state/identityStore', () => ({
  useIdentity: () => person, getState: () => person,
  isRealUser: (value = person) => value.status === 'ready' && value.me.source === 'token', subscribe: () => () => {},
}));

const song = { title: 'Linen Spiral', path: '/music/Paper/01.mp3', relPath: 'Paper/01.mp3', artist: 'Ember Orchestra', duration: 120, track_number: 1 };
const album = { album: 'Paper', artist: 'Ember Orchestra', path: '/music/Paper', tracks: [song], cover: null };
const listingPath = '/api/listar-albums-con-metadata';
const libraryPath = '/api/me/library';
const missingPath = '/api/me/library/missing';
let forced: boolean;
let logs: { level: string; message: string }[];
let owned: Set<string>;
let requests: Request[];
let jobs: Record<string, unknown>[];
let acquisitionState: string | null;
let files: OfflineTrackStatus[];
let events: Map<string, Set<(payload?: unknown) => void>>;
let client: QueryClient;
let restoreBridge: () => void;
let post: (() => Promise<Response>) | undefined;
let deletion: (() => Promise<Response>) | undefined;
let delayListing: Promise<Response> | undefined;
let snapshot: (() => Promise<unknown>) | undefined;
const count = (path: string) => requests.filter(r => new URL(r.url).pathname === path && r.method === 'GET').length;
const emit = (channel: string, payload?: unknown) => act(() => events.get(channel)?.forEach(listener => listener(payload)));
const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
function Wrapper({ children }: { children: ReactNode }) { return <DataProvider queryClient={client}><UiProvider>{children}</UiProvider></DataProvider>; }
function conditional(request: Request, data: unknown) {
  const etag = `"${JSON.stringify(data)}"`;
  return request.headers.get('If-None-Match') === etag
    ? new Response(null, { status: 304, headers: { ETag: etag } })
    : Response.json(data, { headers: { ETag: etag } });
}

beforeEach(async () => {
  focusManager.setFocused(true);
  localStorage.clear(); localStorage.setItem('krobi.bottomBarDrawerOpen', '0'); resetBrowse(); resetLibrary(); resetLibraryJobs(); resetApiClient();
  setLibraryRoot('/music'); person.me.isOwner = false; person.me.id = 'ana';
  forced = false; logs = [];
  owned = new Set([song.relPath]); requests = []; jobs = []; files = []; events = new Map();
  acquisitionState = null; post = undefined; deletion = undefined; delayListing = undefined; snapshot = undefined;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } } });
  const fake = {
    invoke: async (channel: string, payload?: { forced?: boolean }) => {
      if (channel === 'app:get-backend-origin') return { origin: 'http://localhost:8000' };
      if (channel === 'server:get-status') return serverStatus();
      if (channel === 'offline:snapshot') return snapshot?.();
      if (channel === 'offline:mode') {
        if (payload?.forced !== undefined) forced = payload.forced;
        return { forced };
      }
      if (channel === 'log:write') { logs.push(payload as unknown as typeof logs[number]); return; }
      if (channel === 'offline:sync') return { ok: true };
      if (channel === 'offline:status') return { tracks: files, files: files.length, bytes: 0, pins: 0 };
      if (channel === 'offline:outbox') return [];
      if (channel === 'upload:status') return { batches: [] };
      if (channel === 'lyrics:engine-status') return { state: 'unavailable' };
      return {};
    },
    on: (channel: string, listener: (payload: unknown) => void) => {
      if (!events.has(channel)) events.set(channel, new Set());
      events.get(channel).add(listener);
      return () => { events.get(channel)?.delete(listener); };
    },
  } as KrobiBridge;
  restoreBridge = setFakeBridgeForTest(fake);
  vi.stubGlobal(BRIDGE_KEY, fake);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (request.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    requests.push(request);
    const url = new URL(request.url), path = url.pathname;
    if (path === '/api/get-basedir') return Response.json({ basedir: '/music' });
    if (path === listingPath) {
      expect(url.searchParams.get('covers')).toBe('false');
      if (delayListing) return delayListing;
      return conditional(request, person.me.isOwner || owned.has(song.relPath) ? [album] : []);
    }
    if (path === libraryPath) {
      if (request.method === 'POST' && post) return post();
      if (request.method === 'DELETE' && deletion) return deletion();
      if (request.method !== 'GET') {
        const data = await request.json();
        for (const key of data.relPaths) if (request.method === 'DELETE') owned.delete(key); else owned.add(key);
        return Response.json({ added: data.relPaths, removed: data.relPaths, missing: [] });
      }
      return conditional(request, { tracks: [...owned].map(relPath => ({ relPath })), count: owned.size });
    }
    if (path === missingPath) return conditional(request, { relPaths: [] });
    if (path === '/api/me') return Response.json(person.me);
    if (path === '/api/users') return Response.json({ users: [{ id: 'ana', label: 'Ana' }, { id: 'luz', label: 'Luz' }] });
    if (path === '/api/jobs') return Response.json({ jobs, degraded: [] });
    if (path === '/api/acquisition/requests' || path === '/api/acquisition/requests/r1') {
      const job = { id: 'r1', title: 'Paper', account_id: 'ana', state: acquisitionState, expected_tracks: 1, imported_tracks: acquisitionState === 'completo' ? 1 : 0, stages: {}, items: [] };
      return Response.json(path.endsWith('/r1') ? job : { requests: acquisitionState ? [job] : [] });
    }
    if (path === '/api/browse/album/deezer/42') return Response.json({ album: { title: 'Paper', artistName: 'Ember Orchestra', ref: { provider: 'deezer', id: '42' } }, tracks: [{ title: song.title, artistName: song.artist, durationSeconds: 120, trackPosition: 1, ref: { provider: 'deezer', id: '1' } }] });
    if (path === '/api/library/ownership') return Response.json({ results: [{ owned: true, match: { ...song, album: 'Paper', durationSeconds: 120 } }] });
    if (path === '/api/playlists') return Response.json([]);
    if (path === '/api/me/home') return Response.json({ recentlyPlayed: [], mostPlayed: [], recentlyAdded: [] });
    return Response.json({});
  }));
  onlineManager.setOnline(false); resetForIdentityChange(); onlineManager.setOnline(true);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
});
afterEach(() => {
  cleanup(); focusManager.setFocused(undefined); stopReconciling(); client.clear(); resetLibrary(); dismissAllNotifications();
  restoreBridge(); resetApiClient(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function useListingAndMissing() {
  const listing = useLibraryAlbums(); const missing = useLibraryMissing();
  return { data: listing.data, missing };
}
async function ready() {
  const hook = renderHook(useListingAndMissing, { wrapper: Wrapper });
  await waitFor(() => expect(hook.result.current.data).toEqual([album]));
  await waitFor(() => expect(count(missingPath)).toBeGreaterThan(0));
  await flush();
  return hook;
}
async function expectRefresh(trigger: () => void | Promise<void>, delayed = true) {
  const before = [count(listingPath), count(libraryPath), count(missingPath)];
  if (delayed) vi.useFakeTimers();
  await act(trigger);
  if (delayed) {
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect([count(listingPath), count(libraryPath), count(missingPath)]).toEqual(before);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    vi.useRealTimers();
  }
  await waitFor(() => expect([count(listingPath), count(libraryPath), count(missingPath)]).toEqual(before.map(n => n + 1)));
}

describe('shared refresh triggers', () => {
  it('dirty focus and offline:synced conditionally refresh all three listings', async () => {
    await ready();
    await expectRefresh(() => { emit('window:focus', false); emit('server:changed', { area: 'library', rev: Date.now() }); emit('window:focus', true); }, false);
    await expectRefresh(() => { emit('offline:synced', null); });
    for (const path of [listingPath, libraryPath, missingPath]) {
      expect(requests.filter(r => new URL(r.url).pathname === path).at(-1).headers.get('If-None-Match')).toBeTruthy();
    }
  });
  it('has no idle timer while visible and preserves data, membership and render count', async () => {
    let renders = 0;
    function useTickListings() {
      const { data: account } = useQuery({
        queryKey: queryKeys.me.libraryAccount('ana'),
        queryFn: ({ signal }) => queryGet(client, queryKeys.me.libraryAccount('ana'), '/api/me/library', { params: { query: { accountId: 'ana' } }, signal }),
      });
      void account;
      return useListingAndMissing();
    }
    const hook = renderHook(() => { renders++; return useTickListings(); }, { wrapper: Wrapper });
    await waitFor(() => expect(hook.result.current.data).toEqual([album])); await flush();
    const membership = getState();
    vi.useFakeTimers();
    // Remount under a fake clock, retaining the query cache.
    hook.unmount();
    const stable = renderHook(() => { renders++; return useTickListings(); }, { wrapper: Wrapper });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    const fullReload = vi.spyOn(membershipStore, 'load');
    logs.length = 0;
    const mounted = renders, data = stable.result.current.data;
    const counts = [count(listingPath), count(libraryPath), count(missingPath)];
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect([count(listingPath), count(libraryPath), count(missingPath)]).toEqual(counts);
    expect(fullReload).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
    expect(stable.result.current.data).toBe(data); expect(getState()).toBe(membership); expect(renders).toBe(mounted);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(count(listingPath)).toBe(counts[0]);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });
  it('coalesces five job endings and later library-changed events at the first 1000 ms deadline', async () => {
    await ready();
    vi.useFakeTimers();
    const fullReload = vi.spyOn(membershipStore, 'load');
    logs.length = 0;
    const counts = [count(listingPath), count(libraryPath), count(missingPath)];
    act(() => { for (let i = 0; i < 5; i++) announceLibraryJob(`job-${i}`, 'succeeded'); });
    await act(async () => vi.advanceTimersByTimeAsync(500));
    act(announceLibraryChanged);
    await act(async () => vi.advanceTimersByTimeAsync(499));
    expect([count(listingPath), count(libraryPath), count(missingPath)]).toEqual(counts);
    expect(fullReload).not.toHaveBeenCalled();
    // Listing and membership start together; the log waits for both.
    let finish!: (response: Response) => void;
    delayListing = new Promise(resolve => { finish = resolve; });
    owned.clear();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect([count(listingPath), count(libraryPath), count(missingPath)]).toEqual(counts.map(n => n + 1));
    expect(fullReload).toHaveBeenCalledOnce();
    expect(logs).toEqual([]);
    await act(async () => { finish(Response.json([])); });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(fullReload).toHaveBeenCalledOnce();
    expect(logs).toEqual([{ level: 'debug', message: 'Biblioteca al día tras cambio local (trabajo job-0 succeeded:1) · 1 → 0 canciones' }]);
  });
  it('reloads membership once for dirty focus and reconnect hello', async () => {
    await ready(); logs.length = 0;
    const fullReload = vi.spyOn(membershipStore, 'load');
    await expectRefresh(() => { emit('window:focus', false); emit('server:changed', { area: 'library', rev: Date.now() }); emit('window:focus', true); }, false);
    await flush();
    expect(fullReload).toHaveBeenCalledOnce();
    expect(logs).toEqual([]);
    logs.length = 0; fullReload.mockClear();
    await act(async () => onlineManager.setOnline(false));
    await expectRefresh(() => { onlineManager.setOnline(true); emit('server:hello', { bootId: 'reconnected', revisions: { library: 1 } }); }, false);
    await flush();
    expect(fullReload).toHaveBeenCalledOnce();
    expect(logs).toEqual([]);
  });
  it('reloads after dirty quiet periods and ignores repeated focused events', async () => {
    await ready(); logs.length = 0;
    const fullReload = vi.spyOn(membershipStore, 'load');
    await expectRefresh(() => { emit('window:focus', false); emit('server:changed', { area: 'library', rev: Date.now() }); emit('window:focus', true); }, false);
    await flush();
    expect(fullReload).toHaveBeenCalledOnce();
    emit('window:focus', true); await flush();
    expect(fullReload).toHaveBeenCalledOnce();
    await expectRefresh(() => { emit('window:focus', false); emit('server:changed', { area: 'library', rev: Date.now() }); emit('window:focus', true); }, false);
    await flush();
    expect(fullReload).toHaveBeenCalledTimes(2);
  });
  it('cancels a pending reload and performs no invalidation, tick or reload in forced offline', async () => {
    await ready();
    vi.useFakeTimers();
    act(announceLibraryChanged);
    await act(async () => vi.advanceTimersByTimeAsync(500));
    // No snapshot: entering offline must never fall through to HTTP either.
    await act(async () => { await setForcedOffline(true); });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const fullReload = vi.spyOn(membershipStore, 'load');
    const before = requests.length;
    logs.length = 0;
    act(() => { announceLibraryChanged(); announceLibraryJob('offline-job', 'succeeded'); });
    emit('offline:synced');
    act(() => { emit('window:focus', false); emit('window:focus', true); });
    // Even a stray online notification cannot override the user's mode.
    act(() => onlineManager.setOnline(true));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(invalidate).not.toHaveBeenCalled();
    expect(fullReload).not.toHaveBeenCalled();
    expect(requests).toHaveLength(before);
    expect(logs).toEqual([]);
  });
  it('starts in forced offline without making any library requests, even with no saved snapshot', async () => {
    forced = true;
    renderHook(useListingAndMissing, { wrapper: Wrapper });
    await flush();
    vi.useFakeTimers();
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    act(announceLibraryChanged);
    act(() => { emit('window:focus', false); emit('window:focus', true); });
    emit('auth:changed', { userId: 'ana', hasToken: true });
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(requests).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
    expect(logs).toEqual([]);
  });
  it('does not queue work while disconnected or reload a pending event after going offline', async () => {
    await ready();
    vi.useFakeTimers();
    act(announceLibraryChanged);
    act(() => onlineManager.setOnline(false));
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    const fullReload = vi.spyOn(membershipStore, 'load');
    const before = requests.length;
    act(announceLibraryChanged);
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(invalidate).not.toHaveBeenCalled();
    expect(fullReload).not.toHaveBeenCalled();
    expect(requests).toHaveLength(before);
  });
  it.each(['succeeded', 'partial'])('a ledger download reaching %s refreshes once, including while Browse is unmounted', async state => {
    await ready();
    jobs = [{ id: 'download-1', kind: 'download', state: 'running', attempt: 1, succeeded: 0, failed: 0, skipped: 0 }];
    await act(reconcile); await flush();
    jobs[0].state = state;
    await expectRefresh(reconcile);
    const before = count(listingPath);
    await act(reconcile); await flush(); expect(count(listingPath)).toBe(before);
  });
  it('an acquisition finishing partial in Trabajos emits one signal for repeated snapshots', async () => {
    await ready(); acquisitionState = 'fetching'; await act(refreshAcquisitions);
    acquisitionState = 'parcial'; await expectRefresh(refreshAcquisitions);
    const before = count(listingPath); await act(refreshAcquisitions); await flush(); expect(count(listingPath)).toBe(before);
  });
  it('a device download completion refreshes once through the existing offline events', async () => {
    await ready();
    files = [{ key: song.relPath, pool: 'offline', state: 'descargando' } as OfflineTrackStatus];
    emit('offline:changed'); await flush(); files[0].state = 'descargado';
    await expectRefresh(() => { emit('offline:changed'); });
    const before = count(listingPath); emit('offline:changed'); await flush(); expect(count(listingPath)).toBe(before);
  });
  it('a finished upload refreshes once through the shell host', async () => {
    const { UploadHost } = await import('../uploads/UploadHost');
    const hook = renderHook(useListingAndMissing, { wrapper: ({ children }) => <Wrapper><UploadHost />{children}</Wrapper> });
    await waitFor(() => expect(hook.result.current.data).toEqual([album])); await flush();
    const changed = vi.fn(); window.addEventListener('library-changed', changed);
    emit('upload:changed', { id: 'upload1', phase: 'terminado' }); await flush();
    emit('upload:changed', { id: 'upload1', phase: 'terminado' }); await flush();
    window.removeEventListener('library-changed', changed); expect(changed).toHaveBeenCalledOnce();
  });
});

function LibraryRows() {
  const query = useLibraryAlbums();
  const data = (query.data || []) as typeof album[];
  return <div aria-label="Library fixture">{data.flatMap(a => a.tracks).map(track => <p key={track.relPath}>{track.title}</p>)}</div>;
}

describe('optimistic membership', () => {
  it('removes immediately, survives focus during Undo, and restores without sending DELETE', async () => {
    render(<Wrapper><LibraryRows /></Wrapper>); await screen.findByText(song.title);
    await act(load); // The connection snapshot can settle after the first catalog paint.
    await act(async () => removeLibrary([song.relPath], false));
    expect(screen.queryByText(song.title)).toBeNull(); expect(screen.getByText('Quitada de tu biblioteca')).toBeVisible();
    act(() => { emit('window:focus', false); emit('window:focus', true); }); await flush(); expect(screen.queryByText(song.title)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' })); expect(await screen.findByText(song.title)).toBeVisible();
    expect(requests.some(r => r.method === 'DELETE')).toBe(false);
  });
  it('waits six visible seconds, restores on DELETE error, and reports it', async () => {
    render(<Wrapper><LibraryRows /></Wrapper>); await screen.findByText(song.title);
    await act(load);
    deletion = async () => new Response(null, { status: 500 }); vi.useFakeTimers();
    await act(async () => removeLibrary([song.relPath], false)); expect(screen.queryByText(song.title)).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(5999)); expect(requests.some(r => r.method === 'DELETE')).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(requests.filter(r => r.method === 'DELETE')).toHaveLength(1);
    expect(screen.getByText(song.title)).toBeVisible(); expect(screen.getByText('No se pudo cambiar la biblioteca.')).toBeVisible();
  });
  it('adds before POST resolves and rolls only that intent back on error', async () => {
    owned.clear(); await load();
    const hook = renderHook(useUserLibrary, { wrapper: Wrapper });
    let reject!: (reason: Error) => void;
    post = () => new Promise((_, fail) => { reject = fail; });
    let pending!: Promise<unknown>;
    act(() => { pending = writeLibrary([song.relPath], 'POST').catch(e => e); });
    expect(hook.result.current.byRelPath[song.relPath]).toBeTruthy();
    await act(load); expect(hook.result.current.byRelPath[song.relPath]).toBeTruthy();
    await act(async () => { reject(new Error('fixture failure')); await pending; });
    expect(hook.result.current.byRelPath[song.relPath]).toBeUndefined();
  });
  it('preserves the owner catalog and uses optimistic membership in the person picker', async () => {
    person.me.isOwner = true;
    const hook = renderHook(() => useLibraryScope([song], [album]), { wrapper: Wrapper });
    await waitFor(() => expect(hook.result.current.people.map(p => p.label)).toEqual(['Ana', 'Luz']));
    expect(hook.result.current.tracks).toHaveLength(1);
    act(() => hook.result.current.setScope('mine'));
    await act(async () => removeLibrary([song.relPath], false));
    expect(hook.result.current.tracks).toHaveLength(0); expect(hook.result.current.mineCount).toBe(0);
    act(() => hook.result.current.setScope('all')); expect(hook.result.current.tracks).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }));
  });
});

it('fixture: Browse Add updates the device action and Library through the same mounted App, without reload', async () => {
  vi.useFakeTimers();
  owned.clear(); localStorage.setItem('krobi.libraryView', 'songs');
  render(<Wrapper><App /></Wrapper>);
  await waitForClock(() => expect(count(listingPath)).toBe(1));
  act(() => push({ kind: 'album', provider: 'deezer', id: '42', title: 'Paper' }));
  // The browse route is lazy-loaded before ownership can render.
  await waitForClock(() => screen.getByRole('img', { name: 'Ya está en el nido · se agrega al instante' }));
  const add = screen.getByRole('button', { name: 'Agregar «Linen Spiral»' });
  let finish!: (value: Response) => void; post = () => new Promise(resolve => { finish = resolve; });
  fireEvent.click(add);
  expect(screen.getByRole('button', { name: 'Descargar en este equipo' }).querySelector('.lucide-arrow-down')).toBeInTheDocument();
  await waitForClock(() => expect(finish).toBeTypeOf('function'));
  await act(async () => { owned.add(song.relPath); finish(Response.json({ added: [song.relPath], missing: [] })); });
  fireEvent.click(screen.getByRole('button', { name: 'Biblioteca' }));
  await waitForClock(() => expect(client.getQueryData(queryKeys.library.albums({ covers: false }))).toEqual([album]));
  await waitForClock(() => expect(screen.getByRole('button', { name: 'Reproducir Linen Spiral' })).toBeVisible());
  expect(screen.getByRole('button', { name: 'Descargar en este equipo' })).toBeVisible();
  expect(screen.queryByText('La biblioteca falló')).toBeNull();
  expect(requests.filter(r => r.method === 'POST' && new URL(r.url).pathname === libraryPath)).toHaveLength(1);
// Cold App/Browse imports and listing updates have independent async boundaries.
}, 15_000);

it('App has no separate album array or listing request', () => {
  const source = appSource;
  expect(source).toContain('useLibraryAlbums()'); expect(source).not.toMatch(/\[albums,\s*setAlbums\]|fetchAlbums|listar-albums-con-metadata/);
});

it('drops validators and late responses when auth changes during a revalidation', async () => {
  const hook = await ready();
  let finish!: (response: Response) => void;
  delayListing = new Promise(resolve => { finish = resolve; });
  emit('server:changed', { area: 'library', rev: 'before-auth' }); await flush();
  const previous = requests.filter(r => new URL(r.url).pathname === listingPath).at(-1);
  expect(previous.headers.has('If-None-Match')).toBe(true);
  delayListing = undefined; owned.clear(); person.me.id = 'luz';
  emit('auth:changed', { userId: 'luz', hasToken: true });
  await waitFor(() => expect(hook.result.current.data).toEqual([]));
  await act(async () => { finish(Response.json([album], { headers: { ETag: '"old-user"' } })); });
  expect(hook.result.current.data).toEqual([]); expect(getState().count).toBe(0);
  expect(requests.filter(r => new URL(r.url).pathname === listingPath).at(-1).headers.has('If-None-Match')).toBe(false);
});

it('a slow pre-write account response cannot overwrite a confirmed add', async () => {
  owned.clear(); await load(); renderHook(useUserLibrary, { wrapper: Wrapper });
  const fetchBefore = fetch;
  let finish!: (response: Response) => void;
  let intercept = true;
  vi.stubGlobal('fetch', async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    if (intercept && new URL(request.url).pathname === libraryPath && request.method === 'GET') {
      intercept = false;
      return new Promise<Response>(resolve => { finish = resolve; });
    }
    return fetchBefore(input, init);
  });
  const stale = load(); await flush();
  await act(async () => writeLibrary([song.relPath], 'POST'));
  await act(async () => { finish(Response.json({ tracks: [], count: 0 })); await stale; });
  expect(getState().byRelPath[song.relPath]).toBeTruthy();
});

it('closing the removal toast settles the deferred DELETE instead of stranding the optimistic row', async () => {
  render(<Wrapper><LibraryRows /></Wrapper>); await screen.findByText(song.title);
  await act(async () => removeLibrary([song.relPath], false));
  fireEvent.click(screen.getByRole('button', { name: 'Descartar: Quitada de tu biblioteca' }));
  await waitFor(() => expect(requests.filter(r => r.method === 'DELETE')).toHaveLength(1));
  expect(getState().byRelPath[song.relPath]).toBeUndefined();
});


it('a Browse add shows the device action during POST and restores the add control with an error toast on failure', async () => {
  owned.clear(); await load();
  let finish!: (response: Response) => void;
  post = () => new Promise(resolve => { finish = resolve; });
  render(<Wrapper><RowEnd title={song.title} trackKey={song.relPath} inNest catalog /></Wrapper>);
  fireEvent.click(screen.getByRole('button', { name: 'Agregar «Linen Spiral»' }));
  expect(screen.getByRole('button', { name: 'Descargar en este equipo' }).querySelector('.lucide-arrow-down')).toBeInTheDocument();
  await act(async () => { finish(new Response(null, { status: 500 })); });
  expect(await screen.findByRole('button', { name: 'Agregar «Linen Spiral»' }, { timeout: 4000 })).toBeVisible();
  expect(screen.getByText('No se pudo cambiar la biblioteca.')).toBeVisible();
});
