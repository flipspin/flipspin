import { playbackEngine } from '../player/engine/PlaybackEngine';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { DataProvider } from '../data';
import { installFakeSettings, serverStatus, type FakeSettings } from '../settings/test-support';
import { STORAGE_NOW } from '@state/playerQueue';
import type { ServerConnection } from '../lib/ipc';
import CoverTile from '../ui/components/CoverTile';

const status = (state: ServerConnection['state']) => serverStatus({ connection: { state, since: 0, attempt: 1, lastError: null, checks: [] } });
let fake: FakeSettings;
beforeEach(async () => {
  await import("../albums/AlbumList");
  localStorage.clear();
  localStorage.setItem('krobi.bottomBarDrawerOpen', '0');
  vi.spyOn(playbackEngine, 'load').mockImplementation(() => {});
  vi.spyOn(playbackEngine, 'pause').mockImplementation(() => {});
  vi.spyOn(playbackEngine, 'play').mockResolvedValue();
});
afterEach(() => { fake?.restore(); vi.restoreAllMocks(); });
const mount = (fail = false) => {
  fake = installFakeSettings({ status: status('connecting'), respond: r => {
    if (fail && ['/api/listar-albums-con-metadata', '/api/playlists'].includes(r.pathname)) return { networkError: 'No route to host' };
    if (r.pathname === '/api/get-basedir') return { status: 200, json: { basedir: '/music' } };
    if (['/api/listar-albums-con-metadata', '/api/playlists'].includes(r.pathname)) return { status: 200, json: [] };
    return { status: 200, json: {} };
  } });
  return render(<DataProvider><App /></DataProvider>);
};
const noEmptyClaims = () => {
  expect(screen.queryAllByText(/Aún no hay álbumes|No hay playlists todavía|Aún no has escuchado|Sin playlists|No se encontraron álbumes|Aún no hay canciones/)).toHaveLength(0);
};

describe('App follows shell connection', () => {
  it('retries a failed cover when the bridge reports the backend connected again', async () => {
    mount();
    const { container } = render(<CoverTile src="krobi-media://localhost/api/media/Recovered/cover.jpg?size=96" label="Recovered" />);
    await act(async () => {});
    const first = container.querySelector('img')!;
    fireEvent.error(first);
    expect(container.querySelector('img')).toBeNull();
    act(() => fake.emitServerStatus(status('connected')));
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
    expect(container.querySelector('img')).not.toBe(first);
    expect(container.querySelector('img')).toHaveAttribute('src', first.getAttribute('src'));
    fireEvent.load(container.querySelector('img')!);
    expect(container.querySelector('img')).toHaveAttribute('data-loaded');
  });

  it('keeps Home, sidebar and Library unknown until a real answer, then fetches albums once', async () => {
    mount();
    await act(async () => {});
    noEmptyClaims();
    expect(fake.requests.filter(r => r.pathname === '/api/listar-albums-con-metadata')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Biblioteca' }));
    await waitFor(() => expect(screen.getAllByRole('status').length).toBeGreaterThan(0));
    noEmptyClaims();
    act(() => fake.emitServerStatus(status('connected')));
    expect(await screen.findByText('No se encontraron álbumes.', {}, { timeout: 5000 })).toBeInTheDocument();
    expect(fake.requests.filter(r => r.pathname === '/api/listar-albums-con-metadata')).toHaveLength(1);
    act(() => fake.emitServerStatus(status('connected')));
    expect(fake.requests.filter(r => r.pathname === '/api/listar-albums-con-metadata')).toHaveLength(1);
  });

  it('keeps failed listings unknown and shows the old banner only for unreachable', async () => {
    mount(true);
    act(() => fake.emitServerStatus(status('connected')));
    await waitFor(() => expect(fake.requests.some(r => r.pathname === '/api/listar-albums-con-metadata')).toBe(true));
    await act(async () => {});
    noEmptyClaims();
    act(() => fake.emitServerStatus(status('connecting')));
    expect(screen.queryByText(/Sin conexión con/)).not.toBeInTheDocument();
    act(() => fake.emitServerStatus(status('unreachable')));
    expect(screen.getByText(/Sin conexión con/)).toBeInTheDocument();
    noEmptyClaims();
    act(() => fake.emitServerStatus(status('needs-auth')));
    expect(screen.queryByText(/Sin conexión con/)).not.toBeInTheDocument();
  });

  it('loads restored cover and audio once on connected, never autoplays, and preserves buffered media on a drop', async () => {
    localStorage.setItem(STORAGE_NOW, JSON.stringify({ path: '/music/Album/song.mp3', title: 'Restored song', albumCover: 'http://localhost:8000/api/media/Album/cover.jpg' }));
    const { container } = mount();
    await act(async () => {});
    expect(playbackEngine.load).not.toHaveBeenCalled();
    expect(container.querySelector('audio')).toBeNull();
    expect(container.querySelector('img[src*="/api/media/Album/cover.jpg"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Esperando al nido' })).toBeDisabled();
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    act(() => fake.emitServerStatus(status('connected')));
    await waitFor(() => expect(playbackEngine.load).toHaveBeenCalledTimes(1));
    expect(container.querySelector('img[src*="/api/media/Album/cover.jpg"]')).not.toBeNull();
    expect(playbackEngine.play).not.toHaveBeenCalled();
    act(() => fake.emitServerStatus(status('connected')));
    act(() => fake.emitServerStatus(status('connecting')));
    act(() => fake.emitServerStatus(status('connected')));
    expect(playbackEngine.load).toHaveBeenCalledTimes(1);
    expect(playbackEngine.play).not.toHaveBeenCalled();
  });
});
