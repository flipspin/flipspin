import { useSyncExternalStore } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { search } = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('./browseApi', async original => ({ ...await original<typeof import('./browseApi')>(), search }));
vi.mock('./useAcquisition', () => ({ useAcquisition: () => ({}) }));
vi.mock('./TrackList', () => ({ ISRC_NOTICE: '', TrackList: () => null }));
vi.mock('./AcquireBar', () => ({ AcquireBar: () => null }));
vi.mock('../plugins', () => ({ pluginRoutes: {} }));
vi.mock('@lib/playlistSummaries', () => ({ usePlaylistSummaries: () => [], fetchPlaylistSummaries: async () => [] }));
vi.mock('../state/useStatus', () => ({ useStatus: () => ({ showSuccess: vi.fn(), showError: vi.fn() }) }));
vi.mock('@state/AudioPlayerContext', () => ({ useAudioPlayer: () => ({ play: vi.fn(), selectedTrack: null }) }));
vi.mock('@state/SettingsContext', () => ({ useSettings: () => ({}) }));

import BrowseRouter from './BrowseRouter';
import LibrarySearchBox from '../library/search/LibrarySearchBox';
import { currentRoute, getState, push, replace, reset, searchRoute, subscribe } from './navigationStore';
import { catalogSearchKey } from './useBrowseSearch';
import { readRecentSearches, rememberSearch, readScopedSearches } from './catalogSearchHistory';

const albums = [{ album: 'Dua Disco', artist: 'Dua', path: '/library/disco', tracks: [] }];
function Harness() {
  useSyncExternalStore(subscribe, getState);
  return <><LibrarySearchBox albums={albums} /><BrowseRouter albums={albums} /></>;
}
let client: QueryClient;
function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  return render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
}
const answer = (query: string) => ({ query, albums: [], tracks: [], playlists: [], artists: [{ name: query, ref: { provider: 'deezer', id: query } }], failed: [] });
const tick = async (ms = 0) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const input = () => screen.getByRole('combobox');
function submit(query: string) {
  fireEvent.focus(input());
  fireEvent.change(input(), { target: { value: query } });
  fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
}
beforeEach(() => {
  reset(); localStorage.clear(); search.mockReset();
  search.mockImplementation((query: string) => Promise.resolve(answer(query)));
  vi.useFakeTimers();
});
afterEach(() => { client?.clear(); reset(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('one top-bar search in the existing router', () => {
  it('never queries the catalog per keystroke, including on a catalog results page; explicit Enter runs full search', async () => {
    mount();
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: 'dua ' } });
    await tick(1000);
    expect(search).not.toHaveBeenCalled(); expect(currentRoute()).toBeNull();
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true });
    await tick(); await tick();
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenLastCalledWith('dua', expect.objectContaining({ mode: 'full', signal: expect.any(AbortSignal) }));
    expect(screen.queryByRole('searchbox')).toBeNull();
    const node = input();
    fireEvent.focus(node);
    fireEvent.change(node, { target: { value: 'dua lipa ' } });
    await tick(1000);
    expect(search).toHaveBeenCalledTimes(1);
    expect(node).toHaveValue('dua lipa ');
    fireEvent.keyDown(node, { key: 'Enter' });
    await tick();
    expect(search).toHaveBeenLastCalledWith('dua lipa', expect.objectContaining({ mode: 'full' }));
    expect(input()).toBe(node);
  });
  it('both result pages start with the same switch; switching keeps and reruns the query while replacing history', async () => {
    push({ kind: 'library-artist', id: 'previous', title: 'Previous page' });
    push({ kind: 'library-search', query: 'dua', title: '' });
    mount();
    const library = screen.getByRole('button', { name: 'Biblioteca 1' });
    expect(library).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('group', { name: 'Ámbito de búsqueda' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Explorar' }));
    await tick(); await tick();
    expect(currentRoute()).toMatchObject({ kind: 'search', query: 'dua', mode: 'full' });
    expect(search).toHaveBeenCalledWith('dua', expect.objectContaining({ mode: 'full' }));
    expect(getState().stack).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Explorar' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Biblioteca 1' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Biblioteca 1' }));
    expect(currentRoute()).toMatchObject({ kind: 'library-search', query: 'dua' });
    expect(getState().stack).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Biblioteca 1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: 'Álbumes' })).toHaveTextContent('Dua Disco');
  });
  it('keeps previous panels, shows progress after 300ms, and ignores superseded responses', async () => {
    const pending = new Map<string, { resolve: (data: ReturnType<typeof answer>) => void; signal: AbortSignal }>();
    search.mockImplementation((q: string, options: { signal: AbortSignal }) => q === 'dua' ? Promise.resolve(answer(q)) : new Promise(resolve => pending.set(q, { resolve, signal: options.signal })));
    push(searchRoute('dua')); const { container } = mount(); await tick(); await tick();
    submit('duaa'); await tick();
    expect(screen.getByText('dua')).toBeInTheDocument();
    expect(container.querySelector('.animate-pulse')).toBeNull();
    await tick(299); expect(screen.queryByText('Buscando…')).toBeNull();
    await tick(1); expect(screen.getByText('Buscando…')).toBeInTheDocument();
    submit('duaab'); await tick();
    expect(pending.get('duaa')!.signal.aborted).toBe(true);
    await act(async () => pending.get('duaab')!.resolve(answer('new result'))); await tick();
    expect(screen.getByText('new result')).toBeInTheDocument();
    await act(async () => pending.get('duaa')!.resolve(answer('stale result'))); await tick();
    expect(screen.queryByText('stale result')).toBeNull();
    expect(screen.getByText('new result')).toBeInTheDocument();
  });
  it('retains panels on failure and permits retry; the top bar reflects the provider failure', async () => {
    search.mockImplementation((q: string) => q === 'dua' ? Promise.resolve(answer(q)) : Promise.reject(Object.assign(new Error('Provider offline'), { kind: 'offline' })));
    push(searchRoute('dua')); mount(); await tick(); await tick();
    submit('lipa'); await tick(1);
    expect(screen.getByText('dua')).toBeInTheDocument();
    fireEvent.focus(input());
    expect(screen.getByRole('option', { name: /Sin conexión/ })).toHaveAttribute('title', 'Provider offline');
    search.mockResolvedValue(answer('lipa'));
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' })); await tick(1);
    expect(screen.getByText('lipa')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Buscar .* en Explorar/ })).toHaveAttribute('aria-disabled', 'false');
  });
  it('preserves full request behavior for older typing routes and Show all', async () => {
    search.mockResolvedValue({ ...answer('dua'), artists: [], playlists: [{ title: 'Mix', ref: { id: '1', provider: 'deezer' } }] });
    push(searchRoute('dua', 'typing')); mount(); await tick(); await tick();
    fireEvent.click(screen.getByRole('button', { name: 'Ver todo' })); await tick();
    expect(search).toHaveBeenLastCalledWith('dua', expect.objectContaining({ mode: 'full' }));
  });
  it('keeps the scope switch on empty and error pages', async () => {
    search.mockRejectedValue(new Error('Provider down'));
    push(searchRoute('absent')); mount(); await tick(1);
    expect(screen.getByRole('button', { name: 'Biblioteca 0' })).toBeVisible();
    expect(screen.getByText('Provider down')).toBeVisible();
    search.mockResolvedValue({ ...answer('none'), artists: [] });
    act(() => replace(searchRoute('none'))); await tick(1);
    expect(screen.getByRole('button', { name: 'Explorar' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/none/, { selector: 'p.italic' })).toBeVisible();
  });
  it('folds cache keys, retains scoped terms, and tolerates blocked storage', () => {
    expect(catalogSearchKey('  CANCIÓN   NIÑO ', 'typing')).toEqual(catalogSearchKey('cancion nino', 'typing'));
    expect(catalogSearchKey('dua', 'typing')).not.toEqual(catalogSearchKey('dua', 'full'));
    rememberSearch('dua');
    expect(readScopedSearches()).toContainEqual({ query: 'dua', scope: 'explore' });
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(readRecentSearches()).toEqual([]);
    expect(() => rememberSearch('dua')).not.toThrow();
  });
});
