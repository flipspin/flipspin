import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { matchSongMenuItems } from './matchMenu';
import { openMatch, closeMatch, openSongMatch, useMatchScope } from './matchStore';

const state = vi.hoisted(() => ({ owner: true, offline: false }));
vi.mock('@state/identityStore', () => ({ getState: () => ({ me: { isOwner: state.owner } }) }));
vi.mock('../offline/policy', () => ({ isOfflineNow: () => state.offline }));
vi.mock('@state/userLibraryStore', () => ({ relPathOf: (song: { relPath?: string }) => song.relPath }));

afterEach(() => { cleanup(); closeMatch(); state.owner = true; state.offline = false; });
describe('matching entry points', () => {
  it('adds the owner single-song action, disables it offline and hides it for members', () => {
    const song = { path: '/music/Album/song.mp3', relPath: 'Album/song.mp3', title: 'Song' };
    const items = matchSongMenuItems(song);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ label: 'Buscar coincidencia en MusicBrainz…', disabled: false });
    if ('onClick' in items[0]) items[0].onClick?.();
    state.offline = true;
    expect(matchSongMenuItems(song)[0]).toMatchObject({ disabled: true });
    state.owner = false;
    expect(matchSongMenuItems(song)).toEqual([]);
    state.owner = true;
    expect(matchSongMenuItems(song, 2)).toEqual([]);
  });
  it('accepts the health-page scope and the song-window callback', () => {
    function Probe() { return createElement('output', null, JSON.stringify(useMatchScope())); }
    render(createElement(Probe));
    act(() => openMatch({ relPaths: ['Album/song.mp3'] }));
    expect(screen.getByRole('status')).toHaveTextContent('"relPaths":["Album/song.mp3"]');
    act(() => openMatch({ albumKey: 'Album', title: 'Album' }));
    expect(screen.getByRole('status')).toHaveTextContent('"albumKey":"Album"');
    act(() => openSongMatch({ path: '/music/Album/song.mp3', title: 'Song' }));
    expect(screen.getByRole('status')).toHaveTextContent('"relPaths":["Album/song.mp3"]');
  });
});
