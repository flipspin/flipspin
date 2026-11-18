import { setLibraryPresence, isTrackPresent } from '../library/trackPresence';
import { render } from "../library/tracks/songMenuTestSupport";
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Menu from '../albums/TrackContextMenu';
import SelectionBar from '../ui/components/SelectionBar';
import RemovalMenu from './RemovalMenu';
import MostPlayedPanel from '../home/MostPlayedPanel';
import { usePlaylistData } from '../playlists/hooks/usePlaylistData';
import { removeActions, useRemoveActions, withRemoveActions } from './removeActions';
import { ConfirmProvider } from '../ui/confirm';
import { ROOT_ALBUM_KEY, setLibraryRoot } from '@lib/libraryKeys';
import i18n from '../i18n';

const fixture = vi.hoisted(() => ({
  person: { status: 'ready', me: { id: 'account', role: 'member', source: 'token' } },
  connected: true, forcedOffline: false,
  library: { byRelPath: {} as Record<string, unknown> },
  files: {} as Record<string, { pool: string; state: string }>,
  invoke: vi.fn(), notify: vi.fn(), changed: vi.fn(),
}));
vi.mock('@state/identityStore', () => ({
  useIdentity: () => fixture.person, getState: () => fixture.person,
  isRealUser: () => fixture.person.me.source === 'token', subscribe: () => () => {},
}));
vi.mock('@state/userLibraryStore', () => ({
  useUserLibrary: () => fixture.library, getState: () => fixture.library,
  relPathOf: track => track?.relPath || track?.path?.replace('/music/', '') || null,
  libraryWriteSettled: vi.fn(), optimisticLibrary: () => vi.fn(),
}));
vi.mock('../connection/connection', () => ({
  useConnection: () => ({ state: fixture.connected ? 'connected' : 'unreachable' }),
  connectionStore: { getSnapshot: () => ({ kind: 'ready', value: { connection: { state: fixture.connected ? 'connected' : 'unreachable' } } }) },
}));
vi.mock('../offline/mode', () => ({ useForcedOffline: () => fixture.forcedOffline, getForcedOffline: () => fixture.forcedOffline }));
vi.mock('../bridge', () => ({ hasBridge: () => true, bridge: () => ({ invoke: fixture.invoke }) }));
vi.mock('../ui/notifications', async original => ({ ...await original<typeof import('../ui/notifications')>(), notify: fixture.notify }));
vi.mock('../browse/resolve', () => ({ announceLibraryChanged: fixture.changed }));
vi.mock('../lyrics/useLyricsMenu', () => ({ useLyricsMenu: () => [] }));
vi.mock('@lib/playHistory', () => ({ usePlayHistory: () => ({ '/music/Album/0.mp3': { n: 2 } }) }));
vi.mock('@state/AudioPlayerContext', () => ({ useAudioPlayer: () => ({
  play: vi.fn(), addToQueue: vi.fn(), addNextInQueue: vi.fn(), setIsPlaying: vi.fn(),
}) }));
vi.mock('../state/useStatus', () => ({ useStatus: () => ({ showSuccess: vi.fn(), showError: vi.fn() }) }));
vi.mock('../library/tracks/useAddToPlaylistMenu', () => ({ useAddToPlaylistMenu: () => ({ refresh: vi.fn(), submenu: () => [] }) }));
vi.mock('./offline', () => ({
  useOffline: () => fixture.files, refreshOffline: vi.fn(),
  isDownloaded: file => file?.pool === 'offline' && ['descargado', 'desactualizado', 'ya no está en el nido'].includes(file.state),
}));

const tracks = [0, 1, 2, 3].map(n => ({ path: `/music/Album/${n}.mp3`, relPath: `Album/${n}.mp3` }));
const download = 'Quitar descarga';
const library = 'Quitar de mi biblioteca';
const deletion = 'Eliminar archivo del nido…';
const labels = (menu: ReturnType<typeof removeActions>) => menu.filter(item => 'label' in item).map(item => item.label);
const state = (downloaded: number[], saved: number[]) => ({
  person: fixture.person, connected: fixture.connected,
  downloaded: new Set(downloaded.map(n => tracks[n].relPath)), library: new Set(saved.map(n => tracks[n].relPath)),
});
async function select(item: ReturnType<typeof removeActions>[number]) {
  await act(async () => { if ('onClick' in item) await item.onClick?.(); });
}
function show(items: ReturnType<typeof removeActions>) {
  return render(<ConfirmProvider><Menu open x={0} y={0} items={withRemoveActions([{ label: 'Play' }], items)} /></ConfirmProvider>);
}

beforeEach(async () => {
  await i18n.changeLanguage('es');
  fixture.person = { status: 'ready', me: { id: 'account', role: 'member', source: 'token' } };
  fixture.connected = true; fixture.forcedOffline = false; fixture.files = {}; fixture.library.byRelPath = {};
  fixture.invoke.mockReset().mockImplementation(async channel => channel === 'offline:pools' ? { pins: [] } : channel === 'offline:snapshot' ? undefined : { ok: true });
  fixture.notify.mockReset(); fixture.changed.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ removed: [], missing: [] })));
});
afterEach(() => { setLibraryPresence(); setLibraryRoot(null); vi.unstubAllGlobals(); });

describe('shared removal menu policy', () => {
  it.each([
    [[0], [], [download]], [[], [0], [library]], [[0], [0], [download, library]], [[], [], []],
  ])('device %j, library %j: exactly %j in order', (downloaded: number[], saved: number[], expected: string[]) => {
    const items = removeActions([tracks[0]], state(downloaded, saved));
    show(items);
    expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Play', ...expected]);
    expect(screen.queryAllByRole('separator')).toHaveLength(expected.length ? 1 : 0);
    expect(items.every(item => !('disabled' in item) || !item.disabled)).toBe(true);
  });
  it('keeps file deletion after a separator in a header with no other menu items', () => {
    fixture.person.me.role = 'owner';
    const items = withRemoveActions([], removeActions([tracks[0]], state([], [])));
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ type: 'separator' }); expect(items[1]).toMatchObject({ label: deletion, danger: true });
  });
  it.each(['token', 'local', 'shared-secret'])('an owner from %s sees file deletion last after its separator', source => {
    fixture.person.me.role = 'owner'; fixture.person.me.source = source;
    const items = removeActions([tracks[0]], state([0], [0]));
    expect(labels(items)).toEqual(source === 'token' ? [download, library, deletion] : [download, deletion]);
    expect(items.at(-2)).toEqual({ type: 'separator' }); expect(items.at(-1)).toMatchObject({ danger: true });
    show(items);
    const last = screen.getAllByRole('menuitem').at(-1)!;
    expect(last).toHaveTextContent(deletion); expect(last.previousElementSibling).toHaveAttribute('role', 'separator');
  });
  it.each(['token', 'local', 'shared-secret', 'anonymous', 'unknown'])('a member from %s never sees file deletion', source => {
    fixture.person.me.source = source;
    expect(labels(removeActions(tracks, state([0], [0])))).not.toContain(deletion);
  });
  it('does not trust isOwner when the role is member', () => {
    Object.assign(fixture.person.me, { isOwner: true });
    expect(labels(removeActions(tracks, state([], [])))).toEqual([]);
  });
  it('hides file deletion offline, including forced offline, without disabling other actions', () => {
    fixture.person.me.role = 'owner'; fixture.library.byRelPath[tracks[0].relPath] = {};
    fixture.files[tracks[0].relPath] = { pool: 'offline', state: 'descargado' };
    const { result, rerender } = renderHook(() => useRemoveActions([tracks[0]]));
    expect(labels(result.current)).toEqual([download, library, deletion]);
    fixture.connected = false; rerender(); expect(labels(result.current)).toEqual([download, library]);
    fixture.connected = true; fixture.forcedOffline = true; rerender(); expect(labels(result.current)).toEqual([download, library]);
  });
  it('deduplicates songs before counting applicable actions', () => {
    fixture.person.me.role = 'owner'; setLibraryRoot('/music');
    const items = removeActions([tracks[0], tracks[0]], state([0], [0]));
    expect(labels(items)).toEqual([download, library, deletion]);
  });
  it.each([
    ['Artist∕Album/CD1∕one.mp3', '/music/Artist/Album/CD1/one.mp3'],
    [`${ROOT_ALBUM_KEY}/one.mp3`, '/music/one.mp3'],
  ])('resolves the relative key %s to the nest file %s', async (relPath, path) => {
    fixture.person.me.role = 'owner'; setLibraryRoot('/music');
    show(removeActions([{ relPath }], state([], [])));
    fireEvent.click(screen.getByRole('menuitem', { name: deletion }));
    await screen.findByRole('alertdialog', { name: '¿Eliminar el archivo del nido?' });
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar archivo' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/delete-track'), expect.objectContaining({ body: JSON.stringify({ path }) })));
  });
  it('omits a missing nest file but still offers its local copy and account row', () => {
    fixture.person.me.role = 'owner';
    expect(labels(removeActions([{ ...tracks[0], missingFromNest: true }], state([0], [0])))).toEqual([download, library]);
  });
});

describe('removal side effects', () => {
  it.each([false, true])('file deletion confirms once before any POST (confirm=%s)', async confirm => {
    fixture.person.me.role = 'owner';
    show(removeActions(tracks.slice(0, 2), state([], [])));
    fireEvent.click(screen.getByRole('menuitem', { name: `${deletion} (2)` }));
    expect(await screen.findByRole('alertdialog', { name: '¿Eliminar 2 archivos del nido?' })).toBeInTheDocument();
    expect(screen.getByText('Se borra para todos. No se puede deshacer.')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: confirm ? 'Eliminar archivo' : 'Cancelar' }));
    if (confirm) {
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST').map(([url, init]) => ({ path: new URL(String(url)).pathname, method: init?.method, body: JSON.parse(init?.body as string) }))).toEqual(tracks.slice(0, 2).map(track => ({ path: '/api/delete-track', method: 'POST', body: { path: track.path } })));
    } else { await act(async () => {}); expect(fetch).not.toHaveBeenCalled(); }
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it.each(['identity', 'role', 'connection', 'forcedOffline'])('rechecks %s after confirming file deletion', async change => {
    fixture.person.me.role = 'owner'; show(removeActions([tracks[0]], state([], [])));
    fireEvent.click(screen.getByRole('menuitem', { name: deletion }));
    await screen.findByRole('alertdialog', { name: '¿Eliminar el archivo del nido?' });
    if (change === 'identity') fixture.person.me.id = 'another-account';
    if (change === 'role') fixture.person.me.role = 'member';
    if (change === 'connection') fixture.connected = false;
    if (change === 'forcedOffline') fixture.forcedOffline = true;
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar archivo' }));
    await act(async () => {}); expect(fetch).not.toHaveBeenCalled();
  });
  it('library removal sends only DELETE /me/library for the applicable songs', async () => {
    const items = removeActions(tracks, state([], [1, 2]));
    await select(items[0]);
    expect(fixture.notify).toHaveBeenCalledOnce();
    await act(async () => fixture.notify.mock.calls[0][0].onExpire());
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/me/library'), expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ relPaths: tracks.slice(1, 3).map(t => t.relPath) }) }));
    expect(fixture.invoke).not.toHaveBeenCalled();
  });
  it('download removal shrinks overlapping pins once without changing the server library', async () => {
    fixture.invoke.mockImplementation(async channel => channel === 'offline:pools' ? { pins: [
      { id: 'album:Album', kind: 'album', ref: 'Album', tracks: tracks.map(t => t.relPath) },
      { id: 'playlist:list', kind: 'playlist', ref: 'list', tracks: tracks.slice(0, 2).map(t => t.relPath) },
      { id: `song:${tracks[0].relPath}`, kind: 'song', ref: tracks[0].relPath, tracks: [tracks[0].relPath] },
    ] } : { ok: true });
    await select(removeActions(tracks, state([0, 1], [0, 1]))[0]);
    expect(fixture.invoke).toHaveBeenCalledWith('offline:pin', { kind: 'album', ref: 'Album', tracks: tracks.slice(2).map(track => ({ key: track.relPath, inLibrary: true })) });
    expect(fixture.invoke).toHaveBeenCalledWith('offline:unpin', { pinId: 'playlist:list' });
    expect(fixture.invoke).toHaveBeenCalledWith('offline:unpin', { pinId: `song:${tracks[0].relPath}` });
    expect(fetch).not.toHaveBeenCalled(); expect(fixture.notify).not.toHaveBeenCalled();
  });
});

it('a mixed selection shows each applicable count, in the same order, with deletion last', () => {
  fixture.person.me.role = 'owner';
  fixture.files = Object.fromEntries(tracks.slice(0, 2).map(track => [track.relPath, { pool: 'offline', state: 'descargado' }]));
  fixture.library.byRelPath = Object.fromEntries(tracks.slice(1).map(track => [track.relPath, {}]));
  render(<SelectionBar count={4} tracks={tracks} onClear={vi.fn()} onPlay={vi.fn()} onPlayNext={vi.fn()} onQueue={vi.fn()} playlistItems={[]} />);
  const toolbar = screen.getByRole('toolbar');
  const buttons = within(toolbar).getAllByRole('button').filter(button => /Quitar descarga|Quitar de mi biblioteca|Eliminar archivo del nido/.test(button.textContent || ''));
  expect(buttons.map(button => button.textContent)).toEqual([`${download} (2)`, `${library} (3)`, `${deletion} (4)`]);
  expect(buttons[2]).toHaveClass('selection-bar__btn--danger'); expect(buttons[2].previousElementSibling).toHaveAttribute('role', 'separator');
});

it('offers the same ordered removal actions for one selected song and hides an empty selection', () => {
  fixture.person.me.role = 'owner';
  fixture.files[tracks[0].relPath] = { pool: 'offline', state: 'descargado' };
  fixture.library.byRelPath[tracks[0].relPath] = {};
  const props = { onClear: vi.fn(), onPlay: vi.fn(), onPlayNext: vi.fn(), onQueue: vi.fn(), playlistItems: [] };
  const { rerender } = render(<SelectionBar {...props} count={2} tracks={[tracks[0], tracks[0]]} />);
  const buttons = within(screen.getByRole('toolbar')).getAllByRole('button').filter(button =>
    /Quitar descarga|Quitar de mi biblioteca|Eliminar archivo del nido/.test(button.textContent || ''));
  expect(buttons.map(button => button.textContent)).toEqual([download, library, deletion]);
  expect(buttons[2].previousElementSibling).toHaveAttribute('role', 'separator');
  rerender(<SelectionBar {...props} count={0} tracks={[]} />);
  expect(screen.queryByRole('toolbar')).toBeNull();
});

it('the header overflow shares the same ordered actions and hides when none apply', () => {
  const { rerender } = render(<RemovalMenu items={removeActions([tracks[0]], state([0], [0]))} />);
  fireEvent.click(screen.getByRole('button', { name: 'Más opciones' }));
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([download, library]);
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
  rerender(<RemovalMenu items={[]} />); expect(screen.queryByRole('button', { name: 'Más opciones' })).toBeNull();
});

it('keeps Home song covers without overflow and opens their ordered actions on right-click', () => {
  fixture.person.me.role = 'owner';
  fixture.files[tracks[0].relPath] = { pool: 'offline', state: 'descargado' };
  fixture.library.byRelPath[tracks[0].relPath] = {};
  render(<MostPlayedPanel albums={[{ album: 'Album', path: '/music/Album', tracks: [{ ...tracks[0], title: 'Song' }] }]} />);
  expect(screen.queryByRole('button', { name: 'Más opciones' })).toBeNull();
  fireEvent.contextMenu(screen.getByRole('button', { name: 'Abrir el álbum de Song' }));
  const actions = screen.getAllByRole('menuitem');
  expect(actions.slice(-3).map(action => action.textContent)).toEqual([download, library, deletion]);
  expect(actions.at(-1)?.previousElementSibling).toHaveAttribute('role', 'separator');
});

it('translates the three actions and the irreversible confirmation in English', async () => {
  await i18n.changeLanguage('en'); fixture.person.me.role = 'owner';
  show(removeActions([tracks[0]], state([0], [0])));
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual(['Play', 'Remove download', 'Remove from my library', 'Delete file from nest…']);
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete file from nest…' }));
  expect(await screen.findByRole('alertdialog', { name: 'Delete the file from the nest?' })).toBeInTheDocument();
  expect(screen.getByText("Deletes it for everyone. It can't be undone.")).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Delete file' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
});

it('deleting a song refreshes the affected playlist from the server without another prompt or client writes', async () => {
  fixture.person.me.role = 'owner';
  setLibraryRoot('/music');
  setLibraryPresence([{ tracks }]);
  let deleted = false;
  // Keep returning the pre-delete desktop snapshot, even after the server commits.
  fixture.invoke.mockImplementation(async channel => channel === 'offline:snapshot'
    ? { body: JSON.stringify({ name: 'First', tracks: [tracks[0], tracks[1], tracks[0]] }), etag: '"old"' }
    : { ok: true });
  vi.mocked(fetch).mockImplementation(async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === '/api/delete-track') {
      deleted = true;
      return Response.json({ success: true, path: tracks[0].path, playlistsUpdated: [{ name: 'First', removed: 2 }, { name: 'Second', removed: 2 }] });
    }
    if (path === '/api/playlists') return Response.json([{ name: 'First' }, { name: 'Second' }]);
    return Response.json({ name: path.split('/')[3], tracks: deleted ? [tracks[1]] : [tracks[0], tracks[1], tracks[0]] });
  });
  let albums = [];
  const { result, rerender } = renderHook(() => usePlaylistData({ albums, selectedPlaylistName: 'First', backendOnline: true }));
  await waitFor(() => expect(result.current.playlistTracks).toHaveLength(3));
  show(removeActions([tracks[0]], state([], [])));
  fireEvent.click(screen.getByRole('menuitem', { name: deletion }));
  fireEvent.click(await screen.findByRole('button', { name: 'Eliminar archivo' }));
  await waitFor(() => expect(result.current.playlistTracks.map(track => track.path)).toEqual([tracks[1].path]));
  // The subsequent library refresh must enrich the committed rows, not reload an old snapshot.
  albums = [];
  await act(async () => rerender());
  expect(result.current.playlistTracks.map(track => track.path)).toEqual([tracks[1].path]);
  expect(isTrackPresent(tracks[0])).toBe(false);
  expect(screen.queryByRole('dialog', { name: /Quitar también/ })).toBeNull();
  expect(screen.queryByText('Deleted')).toBeNull();
  const requests = vi.mocked(fetch).mock.calls;
  expect(requests.some(([url]) => String(url).endsWith('/api/playlists/Second'))).toBe(true);
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/playlists/First'), { cache: 'no-store' });
  expect(requests.some(([, init]) => init?.method === 'PUT')).toBe(false);
});

it('committed personal-library removal refreshes playlists named by the response', async () => {
  vi.mocked(fetch).mockImplementation(async (url) => String(url).endsWith('/api/me/library')
    ? Response.json({ removed: [tracks[0].relPath], playlistsUpdated: [{ name: 'Mine', removed: 1 }] })
    : Response.json({ name: 'Mine', tracks: [] }));
  await select(removeActions([tracks[0]], state([], [0]))[0]);
  await act(async () => fixture.notify.mock.calls[0][0].onExpire());
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/api/playlists/Mine'), expect.anything()));
});
