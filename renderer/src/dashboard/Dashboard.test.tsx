import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('../data', async original => ({ ...await original<typeof import('../data')>(), apiGet: mocks.apiGet, useCurrentUser: () => ({ data: { username: 'Test', role: 'member' } }) }));
vi.mock('@state/SettingsContext', () => ({ useSettings: () => ({ mode: 'light', setMode: vi.fn() }) }));
vi.mock('@state/LibraryContext', () => ({ useLibrary: () => ({ baseDir: '' }) }));
vi.mock('@state/AudioPlayerContext', () => ({ useAudioPlayer: () => ({ play: vi.fn() }) }));
vi.mock('../shell/ServerBadge', () => ({ openSettings: vi.fn(), useNestStatus: () => ({ label: 'Test nest', color: 'var(--teal)', hint: '' }) }));
vi.mock('../attention/useAttention', () => ({ useAttention: () => ({ data: null, refetch: vi.fn(), isFetching: false }) }));
vi.mock('../downloads/DownloadsMenu', () => ({ default: () => null }));
vi.mock('../browse/useAcquisition', () => ({ useAcquisition: () => ({}) }));
vi.mock('../browse/TrackList', () => ({ TrackList: () => null }));
vi.mock('../browse/AcquireBar', () => ({ AcquireBar: () => null }));

import Dashboard from './Dashboard';
import Header from '../shell/layout/header';
import { push, reset } from '../browse/navigationStore';
import { useExploreRefresh } from '../library/search/topSearchState';

const data = { rows: [], cached_at: '2026-11-13T12:00:00Z', stale: false };
beforeEach(() => { reset(); mocks.apiGet.mockReset(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-13T12:05:00Z')); });
afterEach(() => { act(() => reset()); vi.useRealTimers(); });
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
function Registration() { return <span data-testid="registered">{String(Boolean(useExploreRefresh()))}</span>; }

it('moves refresh to the Explore top bar, calls the same forced load, disables and spins while loading, and ages its tooltip', async () => {
  let resolve!: (value: typeof data) => void;
  mocks.apiGet.mockResolvedValueOnce(data).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<><Header activePage="dashboard" /><Dashboard /><Registration /></>);
  const button = screen.getByRole('button', { name: 'Actualizar Explorar' });
  expect(button).toBeDisabled();
  expect(button.querySelector('svg')).toHaveClass('animate-spin');
  await settle();
  expect(mocks.apiGet).toHaveBeenNthCalledWith(1, '/api/dashboard', { params: { query: {} } });
  expect(button).toBeEnabled();
  expect(button).toHaveClass('topbar-control', 'topbar-control--icon');
  expect(button.nextElementSibling?.querySelector('.app-account__trigger')).toBeTruthy();
  expect(button.title).toMatch(/Actualizar Explorar · actualizado .*5/);
  expect(within(view.container.querySelector('main') || view.container).queryByRole('searchbox')).toBeNull();
  const pageHeader = view.container.querySelectorAll('header')[1];
  expect(within(pageHeader).queryByRole('search')).toBeNull();
  expect(within(pageHeader).queryByRole('button')).toBeNull();
  fireEvent.click(button);
  expect(mocks.apiGet).toHaveBeenNthCalledWith(2, '/api/dashboard', { params: { query: { refresh: true } } });
  expect(button).toBeDisabled(); expect(button.querySelector('svg')).toHaveClass('animate-spin');
  await act(async () => resolve(data)); await settle();
  expect(button).toBeEnabled(); expect(button.querySelector('svg')).not.toHaveClass('animate-spin');
  await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
  expect(button.title).toMatch(/actualizado .*6/);
  view.rerender(<Registration />);
  expect(screen.getByTestId('registered')).toHaveTextContent('false');
});

it('shows refresh only on the Explore page, never on catalog results/details or other shell pages', async () => {
  mocks.apiGet.mockResolvedValue(data);
  const view = render(<><Header activePage="dashboard" /><Dashboard /></>); await settle();
  expect(screen.getByRole('button', { name: 'Actualizar Explorar' })).toBeVisible();
  for (const kind of ['album', 'artist', 'playlist', 'search', 'library-search']) {
    act(() => { reset(); push({ kind, id: 'test', query: 'query', title: 'Test' }); });
    expect(screen.queryByRole('button', { name: 'Actualizar Explorar' })).toBeNull();
  }
  act(() => reset());
  for (const activePage of ['home', 'albums', 'playlists', 'settings']) {
    view.rerender(<><Header activePage={activePage} /><Dashboard /></>);
    expect(screen.queryByRole('button', { name: 'Actualizar Explorar' })).toBeNull();
  }
});

it('retains the cached/stale banner and enables refresh after failure', async () => {
  mocks.apiGet.mockResolvedValueOnce({ ...data, stale: true }).mockRejectedValueOnce(new Error('Provider unavailable'));
  render(<><Header activePage="dashboard" /><Dashboard /></>); await settle();
  expect(screen.getByRole('status')).toHaveTextContent('Datos en caché.');
  const refresh = screen.getByRole('button', { name: 'Actualizar Explorar' });
  fireEvent.click(refresh); await settle();
  expect(screen.getByRole('status')).toHaveTextContent('Datos en caché.');
  expect(screen.getByText(/Provider unavailable/)).toBeVisible();
  expect(refresh).toBeEnabled();
});
