import { act, fireEvent, render as renderUi, renderHook as renderUiHook, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { DataProvider } from '../data/provider';
import { useLibraryMissing } from '../data/hooks/use-library-missing';
import { resetApiClient } from '../data/backend';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KrobiBridge, OfflineTrackStatus } from '../lib/ipc';
import { setFakeBridgeForTest } from '../bridge';
import { UiProvider } from '../ui';
import { connectionStore } from '../connection/connection';
import CollectionActions from './CollectionActions';
import PersonScope from './PersonScope';
import { RowEnd } from './RowState';
import { trackProgress } from './trackProgress';
import i18n from '../i18n';
import SongTableHeader from '../library/tracks/SongTableHeader';
import SelectionBar from '../ui/components/SelectionBar';
import acquisitionCss from './acquisition.css?raw';
import userEvent from '@testing-library/user-event';
import { useAcquisition } from '../browse/useAcquisition';
import { useLibraryScope } from '../albums/hooks/useLibraryScope';
import { refreshOffline } from './offline';
import { removeLibrary } from './libraryActions';
import { useRemoveActions } from './removeActions';
import type { AcquisitionItem, AcquisitionRequest } from './api';
import AlbumTrackRowUntyped from '../albums/AlbumTrackRow';
import type { ComponentType, ReactNode } from 'react';

const AlbumTrackRow = AlbumTrackRowUntyped as unknown as ComponentType<Record<string, unknown>>;

const fixture = vi.hoisted(() => ({
  person: { status: 'ready', me: { id: 'ana', label: 'Ana', source: 'token', isOwner: true } },
  library: { byRelPath: {} as Record<string, { relPath: string }>, count: 0, capability: 'ready' },
  missing: {} as Record<string, string[]>,
  load: vi.fn(async () => {}),
}));
vi.mock('@state/identityStore', () => ({ useIdentity: () => fixture.person, getState: () => fixture.person, isRealUser: (p = fixture.person) => p.status === 'ready' && p.me.source === 'token', subscribe: () => () => {} }));
vi.mock('@state/userLibraryStore', () => ({ useUserLibrary: () => fixture.library, getState: () => fixture.library, subscribe: () => () => {}, relPathOf: t => t?.relPath || t?.path?.replace('/music/', '') || null, load: fixture.load, resetLibrary: vi.fn(), libraryWriteSettled: vi.fn(),
  optimisticLibrary: (keys, method) => {
    const previous = { ...fixture.library.byRelPath };
    for (const key of keys) {
      if (method === 'DELETE') delete fixture.library.byRelPath[key];
      else fixture.library.byRelPath[key] = { relPath: key };
    }
    fixture.library.count = Object.keys(fixture.library.byRelPath).length;
    return (commit = false) => { if (!commit) { fixture.library.byRelPath = previous; fixture.library.count = Object.keys(previous).length; } };
  },
}));

const tracks = [{ title: 'Linen Spiral', relPath: 'Paper/01.mp3' }, { title: 'Ceramic Steps', relPath: 'Paper/02.mp3' }];
let queryClient: QueryClient;
const TestDataProvider = ({ children }: { children: ReactNode }) => <DataProvider queryClient={queryClient}>{children}</DataProvider>;
const render = (ui: ReactNode) => renderUi(ui, { wrapper: TestDataProvider });
function renderHook<Result>(hook: () => Result) { return renderUiHook(hook, { wrapper: TestDataProvider }); }
let files: OfflineTrackStatus[];
let offlineChanged: () => void;
let serverChanged: (status: unknown) => void;
let restore: () => void;
let stopConnection: () => void;
let invoke: ReturnType<typeof vi.fn>;
let requests: { path: string; method: string; body?: unknown; key?: string }[];
let request: AcquisitionRequest;
let fetched: AcquisitionRequest;
const initialRequest = (): AcquisitionRequest => ({ id: 'r1', kind: 'album', provider: 'deezer', provider_id: '42', title: 'Paper', state: 'approved', expected_tracks: 2, imported_tracks: 0 });
const file = (key: string, state: OfflineTrackStatus['state']): OfflineTrackStatus => ({ key, state, pool: 'offline', bytes: 40, etag: null, verifiedAt: state === 'ya no está en el nido' ? 1 : null, lastPlayedAt: null, error: null });
const saved = (n: number) => { fixture.library.byRelPath = Object.fromEntries(tracks.slice(0, n).map(t => [t.relPath, { relPath: t.relPath }])); fixture.library.count = n; };
beforeEach(async () => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  resetApiClient(); fixture.missing = {};
  fixture.person.me.source = 'token'; fixture.person.me.isOwner = true; fixture.person.me.id = 'ana';
  saved(0); files = []; requests = []; request = initialRequest(); fetched = request;
  invoke = vi.fn(async (channel, body) => {
    if (channel === 'app:get-backend-origin') return { origin: 'http://localhost:8000' };
    if (channel === 'server:get-status') return { connection: { state: 'connected' } };
    if (channel === 'offline:status') return { tracks: files.filter(f => body.keys.includes(f.key)), pins: 0, bytes: 0, files: files.length };
    if (channel === 'offline:pin') return { ok: true, pinId: `${body.kind}:${body.ref}` };
    if (channel === 'offline:unpin') return { ok: true };
    if (channel === 'offline:pools') return { pins: files.map(f => ({ id: `song:${f.key}`, kind: 'song', ref: f.key, tracks: [f.key] })) };
  });
  restore = setFakeBridgeForTest({ invoke, on: (channel, listener) => { if (channel === 'offline:changed') offlineChanged = listener as () => void; if (channel === 'server:status-changed') serverChanged = listener as (status: unknown) => void; return () => {}; } } as KrobiBridge);
  stopConnection = connectionStore.subscribe(() => {});
  await refreshOffline();
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const path = String(url instanceof Request ? url.url : url).replace(/^https?:\/\/[^/]+/, '');
    requests.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined, key: init.headers?.['Idempotency-Key'] });
    if (path === '/api/acquisition/requests' && !init.method) return Response.json({ requests: [] });
    if (path === '/api/acquisition/requests' && init.method === 'POST') return Response.json(request);
    if (path.endsWith('/retry')) return Response.json({ ...request, state: 'approved' });
    if (path.endsWith('/cancel')) return Response.json({ ...request, state: 'rechazado' });
    if (path === '/api/acquisition/requests/r1') return Response.json(fetched);
    if (path === '/api/me/library' && init.method) return Response.json({ added: [], missing: [], removed: tracks.map(t => t.relPath) });
    if (path === '/api/users') return Response.json({ users: [{ id: 'ana', label: 'Ana' }, { id: 'luz', label: 'Luz' }] });
    if (path.startsWith('/api/me/library/missing')) return Response.json({ relPaths: fixture.missing[new URL(path, 'http://localhost').searchParams.get('accountId')] || [] });
    if (path.includes('accountId=luz')) return Response.json({ tracks: [{ relPath: 'Paper/02.mp3' }], count: 1 });
    if (path.includes('accountId=ana')) return Response.json({ tracks: Object.values(fixture.library.byRelPath), count: fixture.library.count });
    if (path === '/api/library/ownership') return Response.json({ results: tracks.map(t => ({ owned: true, match: t })) });
    return Response.json({});
  }));
});
afterEach(() => { queryClient.clear(); resetApiClient(); stopConnection(); restore(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
const controls = (acquisition?) => <CollectionActions kind="album" refId="Paper" title="Paper" tracks={tracks} acquisition={acquisition} />;

describe('selection bar · Descargar', () => {
  const bar = (clear = vi.fn()) => render(<SelectionBar tracks={tracks} count={2} onClear={clear} onPlay={vi.fn()} onPlayNext={vi.fn()} onQueue={vi.fn()} playlistItems={[]} sendItems={[]} />);
  it('pins each selected song that is not downloaded yet, then clears the selection', async () => {
    saved(2); files = [file(tracks[0].relPath, 'descargado')]; await refreshOffline();
    const clear = vi.fn(); bar(clear);
    await act(refreshOffline);
    fireEvent.click(screen.getByRole('button', { name: 'Descargar' }));
    await waitFor(() => expect(clear).toHaveBeenCalled());
    const pins = invoke.mock.calls.filter(([channel]) => channel === 'offline:pin').map(([, body]) => body);
    expect(pins).toEqual([{ kind: 'song', ref: tracks[1].relPath, tracks: [{ key: tracks[1].relPath, inLibrary: true }] }]);
  });
  it('is disabled with a reason when every song is already here, or nobody is signed in', async () => {
    saved(2); files = tracks.map(t => file(t.relPath, 'descargado')); await refreshOffline();
    const { unmount } = bar(); await act(refreshOffline);
    expect(screen.getByRole('button', { name: 'Descargar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Descargar' }).title).toBe('Ya están descargadas en este equipo');
    unmount(); fixture.person.me.source = 'local'; bar();
    expect(screen.getByRole('button', { name: 'Descargar' }).title).toContain('Inicia sesión con tu cuenta');
  });
});

describe('playlist hero · icon-only collection verbs', () => {
  const hero = (empty = false) => <CollectionActions variant="icons" kind="playlist" refId="list" title="Paper" tracks={empty ? [] : tracks} />;
  it.each([0, 1, 2])('library %s follows account rows for members and owners', async n => {
    saved(n);
    const { rerender } = render(hero());
    const label = n === 2 ? 'Las 2 canciones están en tu biblioteca' : n === 1 ? '1 de 2 en tu biblioteca · agregar la 1 que falta' : 'Agregar las 2 canciones a tu biblioteca';
    const button = screen.getByRole(n === 2 ? 'img' : 'button', { name: label });
    expect(button.title).toBe(label);
    expect(button.textContent).toBe('');
    expect(button.querySelector('.lucide-library-big')).toBeInTheDocument();
    expect(button.querySelectorAll('.acquire-action__badge')).toHaveLength(n === 2 ? 1 : 0);
    expect(button.querySelectorAll('.acquire-action__dot')).toHaveLength(n === 1 ? 1 : 0);
    expect(button.querySelectorAll('.acquire-action__badge .lucide-check')).toHaveLength(n === 2 ? 1 : 0);
    expect(button.classList.contains('is-complete')).toBe(n === 2);
    fixture.person.me.isOwner = false; rerender(hero());
    expect(screen.getByRole(n === 2 ? 'img' : 'button', { name: label })).toBeInTheDocument();
  });
  it.each([0, 1, 2])('download %s keeps its tray glyph and badges only all', async n => {
    files = tracks.slice(0, n).map(t => file(t.relPath, 'descargado'));
    render(hero()); await act(refreshOffline);
    const label = n === 2 ? 'Descargado' : n === 1 ? 'Descargar · Descargado 1 / 2' : 'Descargar';
    const button = screen.getByRole(n === 2 ? 'img' : 'button', { name: label });
    expect(button.title).toBe(label);
    expect(button.textContent).toBe('');
    expect(button.querySelector('.lucide-download')).toBeInTheDocument();
    expect(button.querySelectorAll('.acquire-action__badge .lucide-check')).toHaveLength(n === 2 ? 1 : 0);
    expect(button.querySelector('.acquire-action__dot')).toBeNull();
    expect(button.classList.contains('is-complete')).toBe(n === 2);
  });
  it.each(['en fila', 'descargando'] as const)('shows a ring and mono n/m while %s', async state => {
    files = [file(tracks[0].relPath, 'descargado'), file(tracks[1].relPath, state)];
    render(hero()); await act(refreshOffline);
    const button = screen.getByRole('button', { name: 'Descargando 1 / 2' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Descargando 1 / 2');
    expect(button.querySelector('.acquire-action__ring.lucide-loader-circle')).toHaveClass('animate-spin');
    expect(button.querySelector('.lucide-download')).toBeInTheDocument();
    expect(button.querySelector('.acquire-action__badge')).toBeNull();
    expect(button.querySelector('.acquire-action__count')).toHaveTextContent('1/2');
  });
  it.each([false, true])('keeps the library glyph and mono progress while adding (all saved=%s)', allSaved => {
    if (allSaved) saved(2);
    render(<CollectionActions variant="icons" kind="playlist" refId="list" title="Paper" tracks={tracks}
      acquisition={{ active: true, completed: 1, total: 2, request: { ...request, state: 'fetching' } } as ReturnType<typeof useAcquisition>} />);
    const button = screen.getByRole('button', { name: 'Agregando 1 / 2' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Agregando 1 / 2');
    expect(button).toHaveClass('acquire-action--progress');
    expect(button).not.toHaveClass('is-complete');
    expect(button.querySelector('.lucide-library-big')).toBeInTheDocument();
    expect(button.querySelector('.acquire-action__ring')).toHaveClass('animate-spin');
    expect(button.querySelector('.acquire-action__count')).toHaveTextContent('1/2');
    expect(button.querySelector('.acquire-action__badge, .acquire-action__dot')).toBeNull();
  });
  it('uses singular state words for one song', () => {
    const one = () => <CollectionActions variant="icons" kind="playlist" refId="list" title="Paper" tracks={tracks.slice(0, 1)} />;
    const { rerender } = render(one());
    expect(screen.getByRole('button', { name: 'Agregar la 1 canción a tu biblioteca' })).toBeInTheDocument();
    saved(1); rerender(one());
    expect(screen.getByRole('img', { name: 'La 1 canción está en tu biblioteca' })).toBeInTheDocument();
  });
  it.each(['light', 'dark'])('shares a 13px theme-green badge with a paper ring in %s', async mode => {
    const style = document.createElement('style'); style.textContent = acquisitionCss; document.head.append(style);
    const previousMode = document.documentElement.getAttribute('data-mode');
    document.documentElement.setAttribute('data-mode', mode);
    try {
      saved(2); files = tracks.map(t => file(t.relPath, 'descargado'));
      const { container } = render(hero()); await act(refreshOffline);
      const badges = container.querySelectorAll('.acquire-action__badge');
      expect(badges).toHaveLength(2);
      for (const badge of badges) {
        const css = getComputedStyle(badge);
        expect(css.width).toBe('13px'); expect(css.height).toBe('13px');
        // jsdom cannot resolve a var() in the background shorthand.
        const rule = Array.from(style.sheet!.cssRules).find(rule => rule instanceof CSSStyleRule && rule.selectorText === '.acquire-action__badge') as CSSStyleRule;
        expect(rule.style.background).toBe('var(--green)');
        expect(css.color).toBe('var(--chalk)');
        expect(css.boxShadow).toBe('0 0 0 2px var(--paper)');
        expect(css.position).toBe('absolute');
        expect(badge.closest('[aria-hidden="true"]')).toBeInTheDocument();
      }
      for (const button of container.querySelectorAll('[role=img].is-complete')) {
        expect(getComputedStyle(button).color).toBe('var(--ink)');
        expect(getComputedStyle(button).opacity).toBe('1');
      }
    } finally {
      style.remove();
      if (previousMode === null) document.documentElement.removeAttribute('data-mode');
      else document.documentElement.setAttribute('data-mode', previousMode);
    }
  });
  it('adds only missing library songs and pins under the playlist identity', async () => {
    saved(1); render(hero());
    fireEvent.click(screen.getByRole('button', { name: '1 de 2 en tu biblioteca · agregar la 1 que falta' }));
    await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ path: '/api/me/library', method: 'POST', body: { relPaths: [tracks[1].relPath] } })));
    fireEvent.click(screen.getByRole('button', { name: 'Descargar' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('offline:pin', { kind: 'playlist', ref: 'list', tracks: tracks.map(t => ({ key: t.relPath, inLibrary: true })) }));
  });
  it('removes library membership with undo and unpins a complete download', async () => {
    saved(2); const { rerender } = render(hero());
    fireEvent.click(screen.getByRole('button', { name: 'Más opciones' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Quitar de mi biblioteca (2)' }));
    await waitFor(() => expect(fixture.library.count).toBe(0));
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }));
    expect(fixture.library.count).toBe(2);
    files = tracks.map(t => file(t.relPath, 'descargado')); rerender(hero()); await act(refreshOffline);
    fireEvent.click(screen.getByRole('button', { name: 'Más opciones' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Quitar descarga (2)' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('offline:unpin', { pinId: `song:${tracks[0].relPath}` }));
  });
  it('keeps capability and empty-list checks with tooltip words', () => {
    fixture.person.me.source = 'shared-secret'; const { rerender } = render(hero());
    for (const label of ['Agregar las 2 canciones a tu biblioteca', 'Descargar']) {
      const button = screen.getByRole('button', { name: label });
      expect(button).toBeDisabled(); expect(button.title).toContain('Inicia sesión con tu cuenta');
    }
    fixture.person.me.source = 'token'; rerender(hero(true));
    expect(screen.getByRole('button', { name: 'Agregar las 0 canciones a tu biblioteca' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Descargar' })).toBeDisabled();
  });
});

describe('canvas states', () => {
  it.each([[0, 'Agregar'], [1, 'Agregado 1 / 2'], [2, 'Agregado']] as const)('library %s: %s', async (n, label) => {
    saved(n); render(controls());
    expect(screen.getByRole(n === 2 ? 'img' : 'button', { name: label })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Descargar' })).toBeEnabled();
  });
  it('shows durable successful counts while adding', () => {
    render(controls({ active: true, completed: 1, total: 2, request: { ...request, state: 'fetching' } }));
    expect(screen.getByRole('button', { name: 'Agregando 1 / 2' })).toBeDisabled();
  });
  it.each([['en fila', 'Descargando 0 / 2'], ['descargando', 'Descargando 0 / 2'], ['descargado', 'Descargado']] as const)('offline %s', async (state, word) => {
    saved(2); files = tracks.map(t => file(t.relPath, state)); render(controls());
    await act(refreshOffline);
    expect(screen.getByRole(state === 'descargado' ? 'img' : 'button', { name: word })).toBeInTheDocument();
    if (state === 'descargado') expect(screen.getByRole('img', { name: word })).toHaveClass('is-complete');
  });
  it.each(['local', 'shared-secret', 'anonymous', 'unknown'])('D5 source=%s disables both controls and rows with a tooltip', source => {
    fixture.person.me.source = source;
    render(<>{controls()}<RowEnd title="Linen Spiral" inNest trackKey={tracks[0].relPath} /></>);
    for (const name of ['Agregar', 'Descargar', 'Agregar «Linen Spiral»']) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled(); expect(button.title).toContain('Inicia sesión con tu cuenta');
    }
    expect(requests.filter(r => r.method === 'POST')).toEqual([]);
  });
  it('D3 pins with account ownership facts so the shell adds the song first', async () => {
    saved(1); render(controls()); fireEvent.click(screen.getByRole('button', { name: 'Descargar' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('offline:pin', { kind: 'album', ref: 'Paper', tracks: [{ key: tracks[0].relPath, inLibrary: true }, { key: tracks[1].relPath, inLibrary: false }] }));
  });
  it('unpins the album without adding it again', async () => {
    saved(2); files = tracks.map(t => file(t.relPath, 'descargado')); render(controls()); await act(refreshOffline);
    expect(screen.queryByRole('button', { name: 'Descargado' })).toBeNull();
    fireEvent.click(screen.getByRole('img', { name: 'Descargado' }));
    expect(invoke.mock.calls.some(([channel]) => channel === 'offline:unpin' || channel === 'offline:pin')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Más opciones' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Quitar descarga (2)' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('offline:unpin', { pinId: `song:${tracks[0].relPath}` }));
    expect(invoke.mock.calls.filter(c => c[0] === 'offline:pin')).toHaveLength(0);
  });
  it('records the playlist pin before catalog acquisition and keeps its identity', async () => {
    const catalog = tracks.map(t => ({ title: t.title, artistName: 'Ember Orchestra' }));
    const acquisition = { requests: undefined, retainedIds: new Set<string>(), ownershipRevision: 0, retryItem: vi.fn(), active: false, completed: 0, total: 2, request: null, error: null, acquire: vi.fn(async () => request), retry: vi.fn(), cancel: vi.fn() };
    const props = { kind: 'playlist' as const, refId: 'paper', title: 'Paper', tracks: catalog, catalog: true, provider: 'deezer', verdicts: [{}, {}] };
    const view = render(<CollectionActions {...props} acquisition={acquisition} />);
    fireEvent.click(screen.getByRole('button', { name: 'Descargar' }));
    await waitFor(() => expect(acquisition.acquire).toHaveBeenCalledWith(catalog, { kind: 'playlist', provider: 'deezer', provider_id: 'paper', title: 'Paper' }));
    expect(invoke).toHaveBeenCalledWith('offline:pin', { kind: 'playlist', ref: 'paper', mode: 'ensure', tracks: [] });
    expect(invoke.mock.invocationCallOrder.find((_order, index) => invoke.mock.calls[index][0] === 'offline:pin')).toBeLessThan(acquisition.acquire.mock.invocationCallOrder[0]);
    view.rerender(<CollectionActions {...props} acquisition={{ ...acquisition, request: { ...request, state: 'completo', imported_tracks: 2 } }} />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('offline:pin', expect.objectContaining({ kind: 'playlist', ref: 'paper' })));
  });
  it('refreshes downloaded marks from offline:changed', async () => {
    render(controls()); files = tracks.map(t => file(t.relPath, 'descargado'));
    act(() => offlineChanged());
    await screen.findByRole('img', { name: 'Descargado' });
  });
  it('uses ServerStatus.connection to refuse catalog writes offline', async () => {
    render(<CollectionActions kind="album" refId="42" title="Paper" tracks={tracks} catalog verdicts={[{}, {}]} />);
    act(() => serverChanged({ connection: { state: 'unreachable' } }));
    const button = screen.getByRole('button', { name: 'Agregar' });
    expect(button).toBeDisabled(); expect(button.title).toBe('Sin conexión con el nido');
    expect(requests.some(r => r.method === 'POST')).toBe(false);
  });
  it('surfaces no-space refusal', async () => {
    invoke.mockImplementation(async channel => channel === 'offline:pin' ? { ok: false, reason: 'no-space' } : { tracks: [], connection: { state: 'connected' } });
    render(<UiProvider>{controls()}</UiProvider>); fireEvent.click(screen.getByRole('button', { name: 'Descargar' }));
    await screen.findByText('No hay espacio en este equipo');
  });
});

const Status = RowEnd;
const item = (state: string, reason?: string, detail = {}): AcquisitionItem => ({ idx: 0, item: 'Linen Spiral', stage: 'fetch', state, reason, detail });
describe('row icons, tooltips and one fixed end cell', () => {
  it('leaves one device icon on library rows and preserves their right-click handler', async () => {
    saved(1); files = [file(tracks[0].relPath, 'descargado')];
    const onContextMenu = vi.fn();
    const track = { title: tracks[0].title, relPath: tracks[0].relPath, path: `/music/${tracks[0].relPath}` };
    const { container } = render(<AlbumTrackRow track={track} index={0} onContextMenu={onContextMenu} />);
    await act(refreshOffline);
    expect(screen.queryByRole('button', { name: 'Más opciones' })).toBeNull();
    expect(container.querySelectorAll('.acquire-row-end svg')).toHaveLength(1);
    fireEvent.contextMenu(container.querySelector('li')!);
    expect(onContextMenu).toHaveBeenCalledWith(track, expect.anything());
  });
  it.each(['ya no está en el nido', 'fallido'] as const)('lets live and just-landed acquisition outrank stale %s', async offlineState => {
    const key = tracks[0].relPath;
    files = [file(key, offlineState)];
    const props = { title: tracks[0].title, catalog: true, trackKey: key, onAdd: vi.fn() };
    const { container, rerender } = render(<RowEnd {...props} item={item('running', null, { percent: 38 })} />);
    await act(refreshOffline);
    expect(screen.getByRole('img', { name: 'Agregando · 38 %' })).toBeVisible();
    expect(container.querySelector('.lucide-file-x, .lucide-plus, .lucide-rotate-ccw')).toBeNull();
    rerender(<RowEnd {...props} acquired item={{ ...item('done'), stage: 'link' }} />);
    expect(container.querySelector('.lucide-file-x, .lucide-plus, .lucide-rotate-ccw')).toBeNull();
  });
  it('shows gone after a verified device song disappears from the nest', async () => {
    const key = tracks[0].relPath;
    saved(1); files = [{ ...file(key, 'descargado'), verifiedAt: 1 }];
    const { container } = render(<RowEnd library title={tracks[0].title} trackKey={key} />);
    await act(refreshOffline);
    expect(screen.getByRole('button', { name: 'Quitar descarga' })).toBeVisible();
    files = [file(key, 'ya no está en el nido')];
    await act(refreshOffline);
    expect(container.querySelector('.lucide-file-x')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agregar de nuevo' })).toBeVisible();
  });
  it.each([
    [{ catalog: true, inNest: true }, 'Ya está en el nido · se agrega al instante', '.lucide-circle-dot', 'nest'],
    [{ near: true, nearDuration: 238 }, 'Otra versión en el nido (3:58)', '.lucide-layers-2', 'near'],
    [{ busy: true }, 'Agregando', '.lucide-loader-circle', 'adding'],
    [{ item: item('running', null, { percent: 42 }) }, 'Agregando · 42 %', '.acquire-progress', 'adding'],
    [{ item: item('queued') }, 'En fila', '.lucide-clock', 'queued'],
    [{ item: item('failed', 'no-encontrada') }, 'No se encontró', '.lucide-search', 'retry'],
    [{ item: item('failed', 'fallo-importar') }, 'No se pudo importar', '.lucide-rotate-ccw', 'failed'],
    [{ missing: true }, 'Ya no está en el nido · + la vuelve a agregar', '.lucide-file-x', 'gone'],
    [{ unavailable: true }, 'No disponible sin conexión', '.lucide-wifi-off', 'unavailable'],
  ])('%s → %s', (props, label, icon, tone) => {
    const { container } = render(<Status title="Linen Spiral" onAdd={vi.fn()} {...props} />);
    const status = screen.getByLabelText(label);
    expect(status).toHaveAttribute('title', label);
    expect(status).toHaveClass(`is-${tone}`);
    const svg = status.querySelector(icon);
    expect(svg).toHaveAttribute('width', '13');
    expect(svg).toHaveAttribute('height', '13');
    expect(svg).toHaveAttribute('stroke-width', '2.5');
    expect(container.querySelector('.acquire-row-end')).toHaveTextContent('');
    expect(container.querySelector('.acquire-dot, .acquire-status-slot')).toBeNull();
    expect(container.querySelectorAll('button')).toHaveLength(['unavailable', 'adding', 'queued'].includes(tone) ? 0 : 1);
  });
  it('shows the library membership check on a plain saved row', () => {
    const catalog = false;
    saved(1);
    const { container } = render(<Status title="Linen Spiral" catalog={catalog} inNest trackKey={tracks[0].relPath} />);
    expect(container.querySelector('.acquire-state')).toBeNull();
    const action = screen.getByRole('button', { name: 'Quitar de mi biblioteca' });
    expect(action).toHaveClass('is-saved');
    expect(action.querySelector('.lucide-check')).toBeInTheDocument();
    expect(container.querySelector('.acquire-row-end')).toHaveTextContent('');
  });
  it('gives an ordinary unsaved row only a plus', () => {
    const { container } = render(<RowEnd title="Linen Spiral" onAdd={vi.fn()} />);
    expect(container.querySelector('.acquire-state')).toBeNull();
    expect(screen.getByRole('button', { name: 'Agregar «Linen Spiral»' }).querySelector('.lucide-plus')).toBeInTheDocument();
  });
  it('keeps header, plain, state and downloaded missing cells at 56px and removes the leading column', async () => {
    saved(1); files = [file(tracks[0].relPath, 'ya no está en el nido')];
    const style = document.createElement('style'); style.textContent = acquisitionCss; document.head.append(style);
    try {
      const { container } = render(<>
        <SongTableHeader sortField="title" sortDir="asc" onSort={vi.fn()} />
        <AlbumTrackRow track={{ title: 'Linen Spiral', relPath: tracks[0].relPath }} index={0} />
        <RowEnd title="Plain" onAdd={vi.fn()} />
        <RowEnd title="Nest" catalog inNest />
      </>);
      await act(refreshOffline);
      expect(container.querySelector('.acquire-dot, .acquire-status-slot')).toBeNull();
      expect(container.querySelector('.retro-song-table__header')?.firstElementChild).toHaveTextContent('#');
      expect(container.querySelector('.retro-song-table__row')?.firstElementChild).toHaveClass('song-row__num');
      const cells = container.querySelectorAll('.acquire-row-end');
      expect(cells).toHaveLength(4);
      for (const cell of cells) {
        expect(getComputedStyle(cell).width).toBe('56px');
        expect(getComputedStyle(cell).flexBasis).toBe('56px');
        expect(getComputedStyle(cell).minWidth).toBe('56px');
      }
      expect(getComputedStyle(container.querySelector('.acquire-state.is-nest')!).color).toBe('var(--teal)');
    } finally { style.remove(); }
  });
  it.each(['es', 'en'])('opens manual search from the sole not-found icon by keyboard (%s)', async language => {
    await i18n.changeLanguage(language);
    try {
      const retry = vi.fn();
      const { container } = render(<RowEnd title="Linen Spiral" item={item('failed', 'no-encontrada')} onRetry={retry} />);
      const action = screen.getByRole('button', { name: language === 'es' ? 'No se encontró' : 'Not found' });
      expect(retry).not.toHaveBeenCalled();
      expect(container.querySelectorAll('button')).toHaveLength(1);
      expect(action.querySelector('.lucide-search')).toBeInTheDocument();
      action.focus();
      await userEvent.keyboard('{Enter}');
      expect(screen.getByRole('dialog', { name: language === 'es' ? 'Buscar de otra forma' : 'Search another way' })).toBeInTheDocument();
      expect(retry).not.toHaveBeenCalled();
    } finally { await i18n.changeLanguage('es'); }
  });
  it('reserves En el nido and the plus action for an unsaved catalog song on the nido', async () => {
    const { container } = render(<Status title="Linen Spiral" catalog inNest trackKey={tracks[0].relPath} />);
    expect(screen.getByRole('img', { name: 'Ya está en el nido · se agrega al instante' })).toBeInTheDocument();
    expect(container.querySelector('.acquire-state.is-nest')).toBeInTheDocument();
    const action = screen.getByRole('button', { name: 'Agregar «Linen Spiral»' });
    expect(action).not.toHaveClass('is-saved');
    expect(action.querySelector('.lucide-plus')).toBeInTheDocument();
    fireEvent.click(action);
    await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ path: '/api/me/library', method: 'POST' })));
    expect(requests.some(r => r.path === '/api/acquisition/requests' && r.method === 'POST')).toBe(false);
  });
  it.each(['listing', 'library', 'offline'] as const)('re-requests a missing file detected by %s with a plus and warning icon', async source => {
    saved(1);
    if (source !== 'listing') fixture.missing.ana = [tracks[0].relPath];
    if (source === 'offline') files = [file(tracks[0].relPath, 'ya no está en el nido')];
    const track = { title: 'Linen Spiral', artist: 'Ember Orchestra', album: 'Paper', relPath: tracks[0].relPath, missingFromNest: source === 'listing', duration: 190, track_number: 1 };
    const { container } = render(<AlbumTrackRow track={track} index={0} onPlay={vi.fn()} />);
    await act(refreshOffline);
    expect(await screen.findByRole('img', { name: 'No está en el nido' })).toBeInTheDocument();
    expect(container.querySelector('.acquire-state.is-gone .lucide-file-x')).toBeInTheDocument();
    const action = screen.getByRole('button', { name: 'Agregar de nuevo' });
    expect(action).toBeEnabled();
    expect(action).toHaveAttribute('title', 'Agregar de nuevo');
    expect(action).not.toHaveClass('is-saved');
    expect(action.querySelector('.lucide-plus')).toBeInTheDocument();
    expect(action.querySelector('.lucide-check')).toBeNull();
    fireEvent.click(action);
    expect(screen.getByRole('img', { name: 'Agregando de nuevo' }).querySelector('svg')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'No está en el nido' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Agregar de nuevo' })).toBeNull();
    await waitFor(() => expect(requests).toContainEqual(expect.objectContaining({
      path: '/api/acquisition/requests', method: 'POST',
      body: expect.objectContaining({ kind: 'song', provider: 'library-readd', provider_id: tracks[0].relPath, title: 'Linen Spiral', tracks: [{ title: 'Linen Spiral', artist: 'Ember Orchestra', album: 'Paper', duration_s: 190, track_number: 1 }] }),
      key: expect.stringMatching(/^[a-f0-9-]{36}$/),
    })));
    expect(requests.some(r => r.path === '/api/me/library' && ['POST', 'DELETE'].includes(r.method))).toBe(false);
    expect(invoke.mock.calls.some(([channel]) => channel === 'offline:pin')).toBe(false);
  });
  it('uses acquisition instead of saving or retrying offline storage when a missing catalog row is clicked', () => {
    saved(1); const add = vi.fn(); const retry = vi.fn();
    render(<Status title="Linen Spiral" inNest missing trackKey={tracks[0].relPath} item={item('failed', 'fallo-descarga')} onAdd={add} onRetry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Agregar de nuevo' }));
    expect(add).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(requests.some(r => ['POST', 'DELETE'].includes(r.method))).toBe(false);
  });
  it('keeps a local downloaded mark when the nido file has gone', async () => {
    saved(1); fixture.missing.ana = [tracks[0].relPath];
    files = [file(tracks[0].relPath, 'ya no está en el nido')];
    render(<RowEnd title="Linen Spiral" inNest trackKey={tracks[0].relPath} />); await act(refreshOffline);
    expect(screen.getByLabelText('Descargado')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Ya no está en el nido · + la vuelve a agregar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agregar de nuevo' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Quitar de mi biblioteca' })).not.toBeInTheDocument();
  });
  it('retries the durable request from a failed row', () => {
    const retry = vi.fn(); render(<RowEnd title="Linen Spiral" onAdd={vi.fn()} item={item('failed', 'fallo-descarga')} onRetry={retry} />);
    const action = screen.getByRole('button', { name: 'Reintentar «Linen Spiral»' });
    expect(action.querySelector('.lucide-rotate-ccw')).toBeInTheDocument();
    expect(action).toHaveAttribute('title', 'Falló la descarga');
    expect(retry).not.toHaveBeenCalled();
    fireEvent.click(action); expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('retries the acquisition once per press when its device copy also failed', async () => {
    files = [file(tracks[0].relPath, 'fallido')];
    const retry = vi.fn();
    const add = vi.fn();
    render(<RowEnd catalog title="Track" trackKey={tracks[0].relPath} item={item('failed', 'fallo-descarga')} onAdd={add} onRetry={retry} />);
    await act(refreshOffline);
    const action = screen.getByRole('button', { name: 'Reintentar «Track»' });
    expect(retry).not.toHaveBeenCalled();
    fireEvent.click(action); expect(retry).toHaveBeenCalledTimes(1);
    fireEvent.click(action); expect(retry).toHaveBeenCalledTimes(2);
    expect(add).not.toHaveBeenCalled();
    expect(invoke.mock.calls.filter(([channel]) => channel === 'offline:pin')).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it.each(['fallo-descarga', 'fallo-importar', 'sin-espacio'])('keeps one failed action despite saved membership (%s)', async reason => {
    saved(1); files = [file(tracks[0].relPath, 'descargado')];
    const retry = vi.fn();
    const { container } = render(<RowEnd catalog acquired title="Track" trackKey={tracks[0].relPath} item={item('failed', reason, { error: 'source refused' })} onRetry={retry} />);
    await act(refreshOffline);
    const action = screen.getByRole('button', { name: 'Reintentar «Track»' });
    expect(action).toHaveAttribute('title', { 'fallo-descarga': 'Falló la descarga', 'fallo-importar': 'No se pudo importar', 'sin-espacio': 'Sin espacio en el nido' }[reason]);
    expect(action).toHaveClass('is-retry');
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    expect(action.querySelector('.lucide-rotate-ccw')).toBeInTheDocument();
    expect(container.querySelector('.lucide-plus')).toBeNull();
    action.focus(); await userEvent.keyboard('{Enter}');
    expect(retry).toHaveBeenCalledOnce();
  });
});

describe('Browse saved device slot', () => {
  it.each(['absent', 'en fila', 'descargando', 'descargado'] as const)('shows exactly one icon for %s', async deviceState => {
    saved(1);
    if (deviceState !== 'absent') files = [file(tracks[0].relPath, deviceState)];
    const { container } = render(<RowEnd catalog acquired inNest title="Linen Spiral" trackKey={tracks[0].relPath} item={{ ...item('done'), stage: 'link' }} />);
    await act(refreshOffline);
    const end = container.querySelector('.acquire-row-end');
    expect(end.querySelectorAll('svg')).toHaveLength(1);
    expect(end.querySelectorAll('.acquire-action-slot')).toHaveLength(1);
    if (deviceState === 'absent') {
      expect(screen.getByRole('button', { name: 'Descargar en este equipo' })).toHaveClass('is-download');
      expect(end.querySelector('.lucide-arrow-down')).toBeInTheDocument();
    } else if (deviceState === 'descargado') {
      expect(screen.getByRole('button', { name: 'Quitar descarga' })).toHaveClass('is-saved');
      expect(end.querySelector('.lucide-check')).toBeInTheDocument();
    } else {
      expect(screen.getByRole('img', { name: 'Descargando' })).toBeVisible();
      expect(end.querySelector('button')).toBeNull();
    }
    expect(screen.queryByRole('button', { name: /Eliminar «/ })).toBeNull();
  });
});

describe('Library playback location', () => {
  const row = () => <AlbumTrackRow track={{ ...tracks[0], path: `/music/${tracks[0].relPath}` }} index={0} onSelect={vi.fn()} />;
  const expectSingleDeviceIcon = (container: HTMLElement) => {
    const end = container.querySelector('.acquire-row-end');
    expect(end?.querySelectorAll('svg')).toHaveLength(1);
    expect(end?.querySelectorAll('.acquire-action-slot')).toHaveLength(1);
    expect(container.querySelector('.lucide-arrow-down-to-line')).toBeNull();
    expect(screen.queryByLabelText('Descargada en este equipo')).toBeNull();
  };
  it('offers a blue download action without an in-library check, and pins the song', async () => {
    saved(1);
    const { container } = render(row());
    const action = screen.getByRole('button', { name: 'Descargar en este equipo' });
    expect(action).toHaveAttribute('title', 'Descargar en este equipo');
    expect(action).toHaveClass('is-download');
    expect(action.querySelector('.lucide-arrow-down')).toBeInTheDocument();
    expect(container.querySelector('.acquire-state, .lucide-check')).toBeNull();
    expectSingleDeviceIcon(container);
    fireEvent.click(action);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('offline:pin', {
      kind: 'song', ref: tracks[0].relPath, tracks: [{ key: tracks[0].relPath, inLibrary: true }],
    }));
    expect(requests.some(r => r.method === 'DELETE')).toBe(false);
  });
  it.each(['descargando', 'en fila'] as const)('shows %s as blue progress with no action', async state => {
    saved(1); files = [file(tracks[0].relPath, state)];
    const { container } = render(row()); await act(refreshOffline);
    expect(screen.getByRole('img', { name: 'Descargando' })).toHaveClass('acquire-download');
    expect(screen.getByRole('img', { name: 'Descargando' })).toHaveAttribute('title', 'Descargando');
    expect(screen.getByRole('img', { name: 'Descargando' }).querySelector('.lucide-loader-circle')).toBeInTheDocument();
    expect(container.querySelector('.acquire-row-end button, .lucide-check')).toBeNull();
    expectSingleDeviceIcon(container);
  });
  it('does not reuse a finished acquisition percentage for device progress', async () => {
    saved(1); files = [file(tracks[0].relPath, 'descargando')];
    const { container } = render(<RowEnd library inNest trackKey={tracks[0].relPath} item={item('done', null, { percent: 42 })} />);
    await act(refreshOffline);
    expect(screen.getByRole('img', { name: 'Descargando' }).querySelector('.animate-spin')).toBeInTheDocument();
    expect(container.querySelector('.acquire-progress')).toBeNull();
    expectSingleDeviceIcon(container);
  });
  it('shows only a green check that unpins the download', async () => {
    saved(1); files = [file(tracks[0].relPath, 'descargado')];
    const { container } = render(row()); await act(refreshOffline);
    const action = screen.getByRole('button', { name: 'Quitar descarga' });
    expect(action).toHaveClass('is-saved');
    expect(action).toHaveAttribute('title', 'Quitar descarga');
    expect(action.querySelector('.lucide-check')).toBeInTheDocument();
    expect(container.querySelector('.acquire-download')).toBeNull();
    expectSingleDeviceIcon(container);
    expect(container.querySelector('.song-row__num + div svg')).toBeNull();
    fireEvent.click(action);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('offline:unpin', { pinId: `song:${tracks[0].relPath}` }));
    expect(fixture.library.byRelPath[tracks[0].relPath]).toBeTruthy();
    expect(requests.some(r => r.method === 'DELETE')).toBe(false);
    expect(screen.queryByRole('button', { name: /Eliminar «/ })).toBeNull();
  });
  it('removes only this song from collection pins, keeping other downloaded songs', async () => {
    saved(2); files = tracks.map(t => file(t.relPath, 'descargado'));
    // Install the pools response by channel, allowing normal status polling.
    const original = invoke.getMockImplementation() as KrobiBridge['invoke'];
    invoke.mockReset().mockImplementation(async (channel, body) => channel === 'offline:pools'
      ? { pins: [{ id: 'album:Paper', kind: 'album', ref: 'Paper', tracks: tracks.map(t => t.relPath) }] }
      : original(channel, body));
    render(row()); await act(refreshOffline);
    fireEvent.click(screen.getByRole('button', { name: 'Quitar descarga' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('offline:pin', {
      kind: 'album', ref: 'Paper', tracks: [{ key: tracks[1].relPath, inLibrary: true }],
    }));
    expect(invoke.mock.calls.some(([channel]) => channel === 'offline:unpin')).toBe(false);
    expect(requests.some(r => r.method === 'DELETE')).toBe(false);
  });
  it('prioritizes a missing nido file over a surviving local copy', async () => {
    saved(1); fixture.missing.ana = [tracks[0].relPath];
    files = [file(tracks[0].relPath, 'ya no está en el nido')];
    const { container } = render(row()); await act(refreshOffline);
    expect(await screen.findByRole('img', { name: 'No está en el nido' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Agregar de nuevo' })).toBeEnabled();
    expect(container.querySelector('.lucide-check, .acquire-download')).toBeNull();
  });
  it('keeps the add behavior for catalog-only rows shown within a library album', () => {
    render(<RowEnd library catalog title="Linen Spiral" onAdd={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Agregar «Linen Spiral»' }).querySelector('.lucide-plus')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Descargar en este equipo' })).toBeNull();
  });
  it('removes personal membership through the menu with an undo toast', async () => {
    saved(1);
    const { result } = renderHook(() => useRemoveActions(tracks));
    const menu = result.current;
    expect(menu).toHaveLength(1);
    expect(menu[0]).toMatchObject({ label: 'Quitar de mi biblioteca' });
    render(<UiProvider>{null}</UiProvider>);
    await act(async () => { if ('onClick' in menu[0]) await menu[0].onClick?.(); });
    expect(screen.getByText('Quitada de tu biblioteca')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }));
    expect(requests.some(r => r.method === 'DELETE')).toBe(false);
  });
});

describe('durable acquisition transport', () => {
  it('posts the body with a fresh Idempotency-Key and reads the real request', async () => {
    const finished = vi.fn(); fetched = { ...request, state: 'parcial', imported_tracks: 1, items: [item('failed', 'no-encontrada')] };
    const { result } = renderHook(() => useAcquisition(finished));
    await act(async () => result.current.acquire([{ title: 'Linen Spiral', artistName: 'Ember Orchestra', ref: { provider: 'deezer', id: '12' } }]));
    await waitFor(() => expect(result.current.request?.state).toBe('parcial'));
    expect(result.current.completed).toBe(1); expect(finished).toHaveBeenCalledOnce();
    const post = requests.find(r => r.method === 'POST');
    expect(post.body).toMatchObject({ kind: 'song', provider: 'deezer', provider_id: '12', tracks: [{ title: 'Linen Spiral', artist: 'Ember Orchestra', provider_id: '12' }] });
    expect(post.key).toMatch(/^[a-f0-9-]{36}$/);
    await act(async () => result.current.acquire([{ title: 'Ceramic Steps' }]));
    expect(new Set(requests.filter(r => r.path === '/api/acquisition/requests' && r.method === 'POST').map(r => r.key)).size).toBe(2);
    expect(requests.some(r => r.path.includes('/api/browse/acquire'))).toBe(false);
  });
  it('uses the existing cancel and retry endpoints', async () => {
    fetched = { ...request, state: 'parcial', imported_tracks: 1 };
    const { result } = renderHook(() => useAcquisition());
    await act(async () => result.current.acquire([{ title: 'Linen Spiral' }]));
    await waitFor(() => expect(result.current.request?.state).toBe('parcial'));
    await act(async () => result.current.retry());
    expect(requests.some(r => r.path === '/api/acquisition/requests/r1/retry' && r.method === 'POST')).toBe(true);
    fetched = { ...request, state: 'approved' };
    await act(async () => result.current.cancel());
    expect(requests.some(r => r.path === '/api/acquisition/requests/r1/cancel' && r.method === 'POST')).toBe(true);
  });
  it('continues watching after a transient GET failure and stops at terminal', async () => {
    vi.useFakeTimers(); const original = fetch;
    let fail = true;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => { if (String(url).endsWith('/r1') && fail) { fail = false; throw new Error('network'); } return original(url, init); }));
    const { result } = renderHook(() => useAcquisition());
    await act(async () => result.current.acquire([{ title: 'Linen Spiral' }]));
    expect(result.current.active).toBe(true); expect(result.current.error).toBeTruthy();
    fetched = { ...request, state: 'completo', imported_tracks: 2 };
    await act(async () => vi.advanceTimersByTimeAsync(1200));
    expect(result.current.active).toBe(false); expect(result.current.completed).toBe(2);
  });
});

describe('removal and visible undo window', () => {
  it('defers DELETE for six visible seconds and Undo cancels it', async () => {
    vi.useFakeTimers(); render(<UiProvider>{null}</UiProvider>);
    await act(async () => removeLibrary([tracks[0].relPath], false));
    await act(async () => vi.advanceTimersByTimeAsync(5999));
    expect(requests.some(r => r.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }));
    await act(async () => vi.advanceTimersByTimeAsync(10));
    expect(requests.some(r => r.method === 'DELETE')).toBe(false);
    await act(async () => removeLibrary([tracks[0].relPath], false));
    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(requests.filter(r => r.method === 'DELETE')).toHaveLength(1);
  });
  it('confirms that a downloaded copy goes too', async () => {
    render(<UiProvider>{null}</UiProvider>); void removeLibrary([tracks[0].relPath], true);
    await screen.findByText('También se eliminará la descarga de este equipo.');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('button', { name: 'Deshacer' })).not.toBeInTheDocument();
  });
});

describe('person scope', () => {
  const people = [{ id: 'ana', label: 'Ana', count: 2, tracks: [] }, { id: 'luz', label: 'Luz', count: 1, tracks: [] }];
  it('owner opens the kit Popover, sees counts and selects a person', () => {
    const select = vi.fn(); render(<PersonScope owner people={people} selectedId="ana" name="Ana" count={2} disabled={false} scoped onSelect={select} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ana · 2' }));
    expect(screen.getByRole('menu', { name: 'Cuenta' })).toHaveClass('k-popover');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Luz 1' })); expect(select).toHaveBeenCalledWith('luz');
  });
  it('member only sees their name', () => {
    render(<PersonScope owner={false} people={people} name="Ana" count={2} disabled={false} scoped onSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Ana · 2' })).not.toHaveAttribute('aria-haspopup');
    expect(screen.queryByText('Luz')).not.toBeInTheDocument();
  });
  it('owner scope reads the selected library, including missing files', async () => {
    saved(1); fixture.library.byRelPath['Paper/gone.mp3'] = { relPath: 'Paper/gone.mp3' };
    fixture.missing.ana = ['Paper/gone.mp3'];
    const local = tracks.map(t => ({ ...t, path: `/music/${t.relPath}` }));
    const { result } = renderHook(() => useLibraryScope(local, []));
    await waitFor(() => expect(result.current.people).toHaveLength(2));
    await waitFor(() => expect(result.current.goneCount).toBe(1));
    act(() => result.current.setOnlyGone(true)); expect(result.current.tracks).toHaveLength(1);
    act(() => { result.current.setOnlyGone(false); result.current.setScope('luz'); });
    await waitFor(() => expect(result.current.tracks.map(t => t.relPath)).toEqual(['Paper/02.mp3']));
  });
  it('member never fetches another account', () => {
    fixture.person.me.isOwner = false;
    const { result } = renderHook(() => useLibraryScope([], []));
    expect(result.current.owner).toBe(false); expect(requests.some(r => r.path === '/api/users')).toBe(false);
  });
  it('unions missing paths once for the owner and keeps selected accounts separate', async () => {
    fixture.missing = { ana: ['Paper/shared.mp3'], luz: ['Paper/shared.mp3', 'Paper/lost.mp3'] };
    const { result } = renderHook(() => useLibraryScope([], []));
    await waitFor(() => expect(result.current.goneCount).toBe(2));
    expect(result.current.tracks.every(track => track.missingFromNest)).toBe(true);
    act(() => result.current.setScope('ana'));
    expect(result.current.goneCount).toBe(1);
    act(() => result.current.setScope('luz'));
    expect(result.current.goneCount).toBe(2);
    expect(requests.filter(r => r.path === '/api/me/library/missing?accountId=luz')).toHaveLength(1);
  });
  it('does not carry missing paths across callers or query sentinel libraries', async () => {
    fixture.missing = { ana: ['Paper/gone.mp3'], luz: [] };
    const { result, rerender } = renderHook(() => useLibraryMissing());
    await waitFor(() => expect(result.current.has('Paper/gone.mp3')).toBe(true));
    fixture.person.me.id = 'luz'; rerender();
    expect(result.current.size).toBe(0);
    await waitFor(() => expect(requests.some(r => r.path === '/api/me/library/missing?accountId=luz')).toBe(true));
    fixture.person.me.source = 'local'; rerender();
    expect(result.current.size).toBe(0);
    expect(requests.some(r => r.path.includes('accountId=local'))).toBe(false);
  });
  it('refreshes the missing listing after the shared catalog changes', async () => {
    fixture.missing.ana = ['Paper/gone.mp3'];
    const { result } = renderHook(() => useLibraryMissing());
    await waitFor(() => expect(result.current.size).toBe(1));
    fixture.missing.ana = [];
    vi.useFakeTimers();
    act(() => window.dispatchEvent(new CustomEvent('library-changed')));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    // Flush TanStack's notification scheduled after the delayed response.
    await act(async () => vi.advanceTimersByTimeAsync(1));
    vi.useRealTimers();
    await waitFor(() => expect(result.current.size).toBe(0));
  });
});


it.each([false, true])('clears missing state and refreshes scoped listings after recovery (immediate completion: %s)', async immediate => {
  saved(1);
  fixture.missing.ana = [tracks[0].relPath];
  request = { ...initialRequest(), kind: 'song', provider: 'library-readd', provider_id: tracks[0].relPath, expected_tracks: 1, state: immediate ? 'completo' : 'fetching', imported_tracks: immediate ? 1 : 0 };
  if (!immediate) files = [file(tracks[0].relPath, 'ya no está en el nido')];
  fetched = { ...request, items: [{ idx: 0, item: 'Linen Spiral', stage: 'fetch', state: 'running', reason: null, detail: { percent: 42 } }] };
  function RecoveryRow() {
    const scope = useLibraryScope([{ path: `/music/${tracks[0].relPath}`, ...tracks[0], missingFromNest: false }], []);
    return <RowEnd library inNest title="Linen Spiral" track={tracks[0]} trackKey={tracks[0].relPath} missing={scope.tracks[0]?.missingFromNest} />;
  }
  render(<RecoveryRow />);
  const missing = renderHook(() => useLibraryMissing());
  await waitFor(() => expect(missing.result.current.has(tracks[0].relPath)).toBe(true));
  const before = requests.filter(r => r.path.includes('accountId=luz')).length;
  if (immediate) fixture.missing.ana = [];
  fireEvent.click(screen.getByRole('button', { name: 'Agregar de nuevo' }));
  expect(screen.getByRole('img', { name: 'Agregando de nuevo' })).toBeInTheDocument();
  if (!immediate) {
    expect(await screen.findByRole('img', { name: 'Agregando de nuevo · 42 %' })).toHaveAttribute('title', 'Agregando de nuevo · 42 %');
    expect(screen.getByRole('img', { name: 'No está en el nido' })).toBeInTheDocument();
    fixture.missing.ana = [];
    fetched = { ...request, state: 'completo', imported_tracks: 1, items: [] };
  }
  await waitFor(() => expect(missing.result.current.has(tracks[0].relPath)).toBe(false), { timeout: 4000 });
  expect(screen.queryByRole('img', { name: 'No está en el nido' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Agregar de nuevo' })).toBeNull();
  expect(screen.getByRole('button', { name: immediate ? 'Descargar en este equipo' : 'Quitar descarga' })).toBeInTheDocument();
  await waitFor(() => expect(requests.filter(r => r.path.includes('accountId=luz')).length).toBeGreaterThan(before));
});

it.each(['es', 'en'])('projects queued → searching → fetching → added with allocated later stages (%s)', async language => {
  await i18n.changeLanguage(language);
  try {
    const stages = ['request', 'match', 'fetch', 'import', 'link'];
    const entries: AcquisitionItem[] = stages.map(stage => ({ idx: 0, item: tracks[0].title, stage,
      state: stage === 'request' ? 'done' : 'queued', reason: null, detail: { index: 0 } }));
    const progress = () => trackProgress({ ...request, expected_tracks: 1, items: entries }, [tracks[0]])[0];
    const row = () => { const state = progress(); return <RowEnd title={tracks[0].title} item={state.item} acquired={state.published} onAdd={vi.fn()} />; };
    const view = render(row());
    expect(screen.getByRole('img', { name: language === 'es' ? 'En fila' : 'Queued' }).querySelector('.lucide-clock')).toBeInTheDocument();
    entries[1].state = 'running'; view.rerender(row());
    const searching = screen.getByRole('img', { name: language === 'es' ? 'Buscando' : 'Searching' });
    expect(searching).toHaveAttribute('title', language === 'es' ? 'Buscando' : 'Searching');
    expect(searching.querySelector('.animate-spin')).toBeInTheDocument();
    expect(view.container.querySelector('.lucide-clock')).toBeNull();
    expect(view.container).toHaveTextContent('');
    entries[1].state = 'done'; view.rerender(row());
    expect(view.container.querySelector('.lucide-clock')).toBeNull();
    entries[2].state = 'running'; entries[2].detail.percent = 42; view.rerender(row());
    expect(screen.getByRole('img', { name: /42 %/ }).querySelector('.acquire-progress')).toBeInTheDocument();
    entries[2].state = entries[3].state = entries[4].state = 'done'; view.rerender(row());
    expect(view.container.querySelector('.lucide-check')).toBeInTheDocument();
    expect(view.container.querySelector('.acquire-state')).toBeNull();
  } finally { await i18n.changeLanguage('es'); }
});
