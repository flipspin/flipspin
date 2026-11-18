import { useRef } from 'react';
import LibraryToolbar from '../albums/LibraryToolbar';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DataProvider, queryKeys } from '../data';
import { installFakeBackend, type FakeBackend, type ResponseSpec } from '../data/test-support';
import { ToastProvider } from '../settings/parts';
import StemsPage from './StemsPage';
import { stemPlayer } from './StemPlayer';
import { originalMix } from './mix';
import { useStemSong } from './useStemSong';
import { libraryStemKey } from './libraryStems';
import { useLibraryView } from '../albums/hooks/useLibraryView';

beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
const track = { album: 'A ∕ B', file: 'song #1.mp3', duration: 357 };
const path = '/api/stems/A%20%E2%88%95%20B/song%20%231.mp3';
const split = { ...track, title: 'Song', artist: 'Artist', albumTitle: 'Album', createdAt: new Date(Date.now() - 2 * 86400000).toISOString(), stale: false, sizeBytes: 18_000_000 };
const manifest = { track: { duration: 357 }, createdAt: split.createdAt, stems: { drums: `${path}/drums`, bass: `${path}/bass`, other: `${path}/other`, vocals: `${path}/vocals` } };
const pending = (status: string, extra = {}) => ({ status, phase: status === 'running' ? 'separating' : 'queued', progress: 62, agent: { online: false }, ...extra });
let backend: FakeBackend;
let client: QueryClient;
let response: ResponseSpec;
let splits = [split];
let owner = true;
let jobs = [];
function setup(initial: ResponseSpec = { status: 200, json: manifest }) {
  response = initial; splits = 'status' in initial && initial.status === 200 ? [split] : []; owner = true; jobs = [];
  backend = installFakeBackend({ respond: r => {
    if (r.pathname === '/api/me') return { status: 200, json: { isOwner: owner } };
    if (r.pathname === '/api/stems') return { status: 200, json: { splits } };
    if (r.pathname === '/api/stems/jobs') return { status: 200, json: { jobs, agent: { online: true }, mode: 'agent' } };
    if (r.pathname === '/api/stems/request') return { status: 200, json: { status: 'queued' } };
    if (r.pathname === path && r.method === 'DELETE') { response = { status: 404 }; splits = []; return { status: 200, json: { removed: true, success: true } }; }
    if (r.pathname === path) return response;
    if (r.pathname === '/api/lyrics/states') return { status: 200, json: { states: {}, counts: { synced: 0, plain: 0, pending: 0, none: 3, instrumental: 0, queued: 0 } } };
  } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}
function Wrapper({ children }: { children: React.ReactNode }) { return <DataProvider queryClient={client}><ToastProvider>{children}</ToastProvider></DataProvider>; }
const page = () => render(<StemsPage track={track} />, { wrapper: Wrapper });
const polls = () => backend.countFor(path);
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
afterEach(async () => { vi.useRealTimers(); client?.clear(); backend?.restore(); vi.restoreAllMocks(); stemPlayer.reset(); await Promise.resolve(); stemPlayer.detach(); });

describe('Stems drawer status rows', () => {
  it.each([
    ['En pistas', { status: 200, json: manifest }, 'hace 2 d'],
    ['Sin separar', { status: 404 }, 'Separar en pistas'],
    ['Pendiente', { status: 202, json: pending('queued') }, 'ningún equipo conectado'],
    ['Separando', { status: 202, json: pending('running') }, 'separar · 62 %'],
    ['No se pudo separar', { status: 202, json: pending('failed', { error: 'el equipo dejó de responder 3 veces' }) }, 'el equipo dejó de responder 3 veces'],
  ] as const)('shows %s with its controls and fact', async (word, wire, fact) => {
    setup(wire); page();
    await screen.findByText(word); expect(screen.getByText(fact)).toBeInTheDocument();
    expect(screen.queryAllByRole('slider').map(s => s.getAttribute('aria-label'))).toEqual(wire.status === 200 ? ['Batería', 'Bajo', 'Otros', 'Voz'] : []);
    if (wire.status !== 200) expect(screen.queryByRole('button', { name: 'Silenciar Voz' })).toBeNull();
    if (word === 'Separando') expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '62');
  });
  it.each(['loading', 'unsupported', 'error'] as const)('shows the engine %s state over a ready split', async state => {
    setup(); vi.spyOn(stemPlayer, 'getSnapshot').mockReturnValue({ state, reason: 'codec', mix: originalMix() }); page();
    await screen.findByText(state === 'loading' ? 'Cargando…' : state === 'unsupported' ? 'No disponible en este equipo' : 'No se pudo cargar');
    await waitFor(() => expect(screen.queryAllByRole('slider')).toHaveLength(0));
    if (state === 'unsupported') expect(screen.getByText('No disponible en este equipo')).toHaveAttribute('title', 'Este equipo no puede decodificar Ogg Opus');
    if (state === 'error') expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });
  it('shows no faders while the song query is unresolved or fails', async () => {
    setup({ status: 500 }); page();
    expect(screen.queryAllByRole('slider')).toHaveLength(0);
    await screen.findByText('No se pudo cargar');
    expect(screen.queryAllByRole('slider')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  });
  it('retries a failed split with the existing request action', async () => {
    setup({ status: 202, json: pending('failed', { error: 'falló' }) }); page();
    fireEvent.click(await screen.findByRole('button', { name: 'Reintentar' }));
    await waitFor(() => expect(backend.countFor('/api/stems/request')).toBe(1));
    expect(screen.queryAllByRole('slider')).toHaveLength(0);
  });
  it('shows a stale split with replacement progress and enabled channels', async () => {
    setup(); splits = [{ ...split, stale: true }]; jobs = [{ ...track, ...pending('running'), progress: 40 }]; page();
    await screen.findByText('Rehaciendo'); expect(screen.getByText('el archivo cambió · 40 %')).toBeInTheDocument();
    expect(screen.getAllByRole('slider')[0]).toBeEnabled();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '40');
  });
  it('opens Helpers and hides destructive actions from members while retaining request', async () => {
    setup({ status: 202, json: pending('queued') }); owner = false; page();
    const event = vi.fn(); window.addEventListener('krobi-show-settings', event);
    fireEvent.click(await screen.findByRole('button', { name: 'Equipos' }));
    expect(event.mock.calls[0][0].detail).toEqual({ section: 'equipos' });
    expect(screen.queryByRole('button', { name: 'Cancelar' })).toBeNull();
    window.removeEventListener('krobi-show-settings', event);
    response = { status: 404 }; await act(() => client.invalidateQueries({ queryKey: queryKeys.stems.all }));
    fireEvent.click(await screen.findByRole('button', { name: 'Separar en pistas' }));
    await waitFor(() => expect(backend.countFor('/api/stems/request')).toBe(1));
  });
  it('cancels a queued split immediately as owner', async () => {
    setup({ status: 202, json: pending('queued') }); page();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
    await screen.findByText('Sin separar'); expect(backend.requests.filter(r => r.method === 'DELETE')).toHaveLength(1);
  });
  it('binds levels, mute, solo, reset and the redo request', async () => {
    setup(); page(); await screen.findByText('En pistas');
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Bajo' }), { key: 'Home' });
    expect(stemPlayer.getSnapshot().mix.levels.bass).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Silenciar Voz' })); expect(stemPlayer.getSnapshot().mix.muted.has('vocals')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Solo Batería' })); expect(stemPlayer.getSnapshot().mix.solo.has('drums')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Volver al original' })); expect(stemPlayer.getSnapshot().mix.levels.bass).toBe(100);
    fireEvent.click(screen.getByRole('button', { name: 'Más: rehacer o eliminar las pistas' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rehacer' })); await waitFor(() => expect(backend.countFor('/api/stems/request')).toBe(1));
  });
  it('opens «⋯» as a menu that Escape closes, giving focus back to «⋯»', async () => {
    setup(); page(); await screen.findByText('En pistas');
    const more = screen.getByRole('button', { name: 'Más: rehacer o eliminar las pistas' });
    fireEvent.click(more);
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Rehacer' }), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(document.activeElement).toBe(more);
  });
  it('defers DELETE for the whole undo window and cancels it with Deshacer', async () => {
    setup(); page(); await screen.findByText('En pistas');
    const remove = () => { fireEvent.click(screen.getByRole('button', { name: 'Más: rehacer o eliminar las pistas' })); fireEvent.click(screen.getByRole('menuitem', { name: 'Eliminar pistas' })); };
    vi.useFakeTimers(); remove(); expect(screen.getByText('Sin separar')).toBeInTheDocument();
    await advance(5999); expect(backend.requests.filter(r => r.method === 'DELETE')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' })); await advance(1); expect(screen.getByText('En pistas')).toBeInTheDocument();
    remove(); await advance(6000); expect(backend.requests.filter(r => r.method === 'DELETE')).toHaveLength(1);
  });
});

describe('visible-song polling', () => {
  it.each(['ready', 'failed'])('polls every two seconds and stops at %s, visibility and song changes', async terminal => {
    setup({ status: 202, json: pending('running') });
    vi.useFakeTimers();
    const refresh = vi.spyOn(stemPlayer, 'refresh');
    const view = renderHook(({ visible, song }) => useStemSong(song, visible), { initialProps: { visible: true, song: track }, wrapper: Wrapper });
    await advance(0); expect(view.result.current.data?.pending).toBeDefined();
    const start = polls(); await advance(1999); expect(polls()).toBe(start); await advance(1); expect(polls()).toBe(start + 1);
    view.rerender({ visible: false, song: track }); await advance(6000); expect(polls()).toBe(start + 1);
    view.rerender({ visible: true, song: track }); await advance(1);
    response = terminal === 'ready' ? { status: 200, json: manifest } : { status: 202, json: pending('failed') };
    await advance(2000); const done = polls(); await advance(6000); expect(polls()).toBe(done);
    if (terminal === 'ready') expect(refresh).toHaveBeenCalledWith(track);
    view.rerender({ visible: true, song: { ...track, file: 'other.mp3' } }); await advance(4000); expect(polls()).toBe(done);
    view.unmount(); const count = backend.requests.length; await advance(4000); expect(backend.requests).toHaveLength(count);
  });
});

describe('Pistas library facet', () => {
  it('places a counted Pistas Select after Letra and includes it in Limpiar', async () => {
    setup();
    const albums = [{ album: 'A', path: '/music/A', tracks: [{ path: '/music/A/a.mp3', title: 'One' }] }];
    function Library() {
      const view = useLibraryView(albums); const searchRef = useRef<HTMLInputElement>(null);
      return <LibraryToolbar view={view} searchRef={searchRef} scoped={false} canScope={false} onScope={() => {}} serverCount={1} mineCount={1} accountName="Fixture" reloading={false} onReload={() => {}} />;
    }
    render(<Library />, { wrapper: Wrapper });
    const selects = screen.getAllByRole('button').filter(b => b.hasAttribute('aria-haspopup'));
    expect(selects.at(-2)).toHaveAttribute('aria-label', 'Letra: Todas'); expect(selects.at(-1)).toHaveAttribute('aria-label', 'Pistas: Todas');
    fireEvent.click(screen.getByRole('button', { name: 'Pistas: Todas' }));
    expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual(['Todas1', 'En pistas0', 'Sin separar1']);
    fireEvent.click(screen.getByRole('option', { name: /En pistas/ })); expect(screen.getByRole('button', { name: 'Limpiar (1)' })).toBeEnabled();
  });
  it('counts and filters on album+file, composes with search, and clears its active count', async () => {
    setup();
    const albums = [{ album: 'A', artist: 'Artist', path: '/music/A', tracks: [
      { path: '/music/A/song #1.mp3', url_path: `/api/media/A%20%E2%88%95%20B/song%20%231.mp3?access_token=ignored`, title: 'Ready' },
      { path: '/music/A/other.mp3', title: 'Other' },
    ] }, { album: 'B', path: '/music/B', tracks: [{ path: '/music/B/song #1.mp3', title: 'Duplicate filename' }] }];
    const view = renderHook(() => useLibraryView(albums), { wrapper: Wrapper });
    await waitFor(() => expect(view.result.current.stems.counts).toEqual({ all: 3, ready: 1, none: 2 }));
    act(() => view.result.current.setPistas('ready')); expect(view.result.current.tracks.map(t => t.title)).toEqual(['Ready']); expect(view.result.current.activeCount).toBe(1);
    act(() => view.result.current.setSearch('missing')); expect(view.result.current.tracks).toHaveLength(0);
    act(() => view.result.current.clearFilters()); expect(view.result.current.tracks).toHaveLength(3); expect(view.result.current.activeCount).toBe(0);
    act(() => view.result.current.setPistas('none')); expect(view.result.current.tracks).toHaveLength(2);
    splits = []; await act(() => client.invalidateQueries({ queryKey: queryKeys.stems.all })); await waitFor(() => expect(view.result.current.stems.counts.ready).toBe(0)); expect(view.result.current.tracks).toHaveLength(3);
    expect(libraryStemKey(albums[0].tracks[0])).toBe(JSON.stringify([track.album, track.file]));
  });
});
