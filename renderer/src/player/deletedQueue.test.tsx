import PlayerTransport from './PlayerTransport';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AudioPlayerProvider, useAudioPlayer } from '../state/AudioPlayerContext';
import { playbackEngine } from './engine/PlaybackEngine';
import { playbackNotice } from './notices';
import { isTrackPresent, setLibraryPresence } from '../library/trackPresence';
import { flush } from '../stems/fakeAudio';

const replayGain = vi.hoisted(() => vi.fn((_album?: string, _file?: string) => ({ gain: null, pending: false })));
vi.mock('./engine/PlaybackEngine', async () => {
  const { fakeAudio } = await import('./fakeAudio');
  return { playbackEngine: fakeAudio().element };
});
vi.mock('./notices', () => ({ playbackNotice: vi.fn() }));
vi.mock('./useReplayGain', () => ({ useReplayGain: replayGain }));
vi.mock('../stems/audioGraph', () => ({ setLevellingGain: vi.fn() }));
vi.mock('../stems/StemPlayer', () => ({ stemPlayer: { setTrack: vi.fn() } }));
vi.mock('../stems/background', () => ({ createBackgroundPreSplit: () => ({ schedule: vi.fn(), cancel: vi.fn() }) }));

vi.mock('@state/AudioAnalyzerContext', () => ({ useAudioAnalyzer: () => ({}) }));
vi.mock('../state/useStatus', () => ({ useStatus: () => ({ showSuccess: vi.fn(), showError: vi.fn() }) }));
vi.mock('../library/tracks/useAddToPlaylistMenu', () => ({ useAddToPlaylistMenu: () => ({ refresh: vi.fn(), submenu: () => [] }) }));
vi.mock('../lyrics/lyricsStore', () => ({ lyricsKeyOf: () => null, useHasLyrics: () => false }));
vi.mock('../library/tracks/useSongMenu', () => ({ useSongMenu: () => ({ build: () => [] }) }));
vi.mock('../lyrics/LyricsModal', () => ({ default: () => null }));

const wrapper = ({ children }: { children?: React.ReactNode }) => <AudioPlayerProvider>{children}</AudioPlayerProvider>;
const tracks = Array.from({ length: 6 }, (_, n) => ({ path: `Album/${n}.mp3`, relPath: `Album/${n}.mp3`, title: String(n) }));
const engine = playbackEngine;

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); setLibraryPresence(); });
afterEach(() => { setLibraryPresence(); });

function restore(upcoming = tracks.slice(1)) {
  localStorage.setItem('playerNowPlaying', JSON.stringify(tracks[0]));
  localStorage.setItem('playerQueue', JSON.stringify(upcoming));
  localStorage.setItem('playerQueueBase', JSON.stringify(upcoming));
  return renderHook(useAudioPlayer, { wrapper });
}

it.each(['next', 'ended', 'shuffle'] as const)('%s skips three absent entries with no media, analysis, notices or failure stop', async action => {
  setLibraryPresence([{ tracks: [tracks[0], tracks[4], tracks[5]] }], 'revision-1');
  const { result } = restore();
  if (action === 'ended') {
    act(() => result.current.setIsPlaying(true));
    await act(async () => { engine.dispatchEvent(new Event('loadedmetadata')); await flush(); engine.dispatchEvent(new Event('playing')); });
  }
  vi.mocked(engine.load).mockClear(); replayGain.mockClear(); vi.mocked(engine.setNext!).mockClear();
  act(() => {
    if (action === 'ended') engine.dispatchEvent(new Event('ended'));
    else { if (action === 'shuffle') result.current.toggleShuffle(); }
  });
  if (action === 'shuffle') expect(result.current.queue.every(isTrackPresent)).toBe(true);
  if (action !== 'ended') act(() => result.current.goNext());
  expect(result.current.nowPlaying).toEqual(action === 'shuffle' ? expect.objectContaining({ relPath: expect.stringMatching(/Album\/[45]\.mp3/) }) : tracks[4]);
  // engine.load is the media-fetch boundary; the three deleted sources never reach it or lookahead.
  expect(engine.load).toHaveBeenCalledTimes(1);
  expect(engine.src).toMatch(/Album\/[45]\.mp3/);
  expect(vi.mocked(engine.setNext!).mock.calls.every(([next]) => !next || !['Album/1.mp3', 'Album/2.mp3', 'Album/3.mp3'].includes(next.key))).toBe(true);
  expect(replayGain.mock.calls.every(call => !['1.mp3', '2.mp3', '3.mp3'].includes(String(call[1])))).toBe(true);
  expect(playbackNotice).not.toHaveBeenCalled();
  expect(result.current.playerState).toBe('loading');
  await act(async () => { engine.dispatchEvent(new Event('loadedmetadata')); await flush(); engine.dispatchEvent(new Event('playing')); });
  expect(result.current.isPlaying).toBe(true);
});

it('all remaining entries absent: stops and emits exactly one notice, including a late ended event', () => {
  setLibraryPresence([{ tracks: [tracks[0]] }]);
  const { result } = restore();
  vi.mocked(engine.load).mockClear();
  act(() => result.current.goNext());
  act(() => engine.dispatchEvent(new Event('ended')));
  expect(result.current).toMatchObject({ playerState: 'paused', isPlaying: false });
  expect(engine.load).not.toHaveBeenCalled();
  expect(playbackNotice).toHaveBeenCalledExactlyOnceWith('empty', '');
});

it('direct picks of absent songs never load or change the queue', () => {
  setLibraryPresence([{ tracks: [tracks[0]] }]);
  const { result } = restore();
  vi.mocked(engine.load).mockClear();
  act(() => result.current.playQueueItemAt(1));
  expect(result.current.queue).toEqual(tracks.slice(1));
  expect(engine.load).not.toHaveBeenCalled();
  expect(playbackNotice).toHaveBeenLastCalledWith('deleted', '');
  act(() => result.current.play(tracks[1]));
  act(() => result.current.setSelectedTrack(tracks[2]));
  expect(engine.load).not.toHaveBeenCalled();
});

it('removes exactly deleted queue occurrences and keeps them out after shuffle is restored', () => {
  setLibraryPresence([{ tracks: [tracks[0], tracks[4]] }]);
  const { result } = restore([tracks[1], tracks[4], tracks[1], tracks[2], tracks[4]]);
  act(() => result.current.removeDeletedSongs());
  expect(result.current.queue).toEqual([tracks[4], tracks[4]]);
  act(() => result.current.toggleShuffle());
  act(() => result.current.toggleShuffle());
  expect(result.current.queue).toEqual([tracks[4], tracks[4]]);
});

it.each([false, true])('media 404 marks a listed song absent for this revision and skips without a failure notice (cacheHit=%s)', async cacheHit => {
  const albums = [{ tracks }];
  setLibraryPresence(albums, 'revision-1');
  const { result } = renderHook(useAudioPlayer, { wrapper });
  act(() => result.current.setQueueWithTracks(tracks));
  if (cacheHit) act(() => engine.dispatchEvent(new CustomEvent('firstByte', { detail: { src: engine.src, cacheHit: true } })));
  await act(async () => { engine.error = { code: 2, status: 404 }; engine.dispatchEvent(new Event('error')); await flush(); });
  expect(isTrackPresent(tracks[0])).toBe(false);
  expect(result.current.nowPlaying).toEqual(tracks[1]);
  expect(playbackNotice).not.toHaveBeenCalled();
  vi.mocked(engine.load).mockClear();
  act(() => result.current.play(tracks[0]));
  expect(engine.load).not.toHaveBeenCalled();
  act(() => setLibraryPresence([...albums], 'revision-1'));
  expect(isTrackPresent(tracks[0])).toBe(false);
  act(() => setLibraryPresence(albums, 'revision-2'));
  expect(isTrackPresent(tracks[0])).toBe(true);
});

it('play-all excludes deleted entries, including a deleted first song', () => {
  setLibraryPresence([{ tracks: [tracks[4], tracks[5]] }]);
  const { result } = renderHook(useAudioPlayer, { wrapper });
  act(() => result.current.setQueueWithTracks(tracks));
  expect(result.current.nowPlaying).toEqual(tracks[4]);
  expect(result.current.queue).toEqual([tracks[5]]);
  expect(engine.load).toHaveBeenCalledOnce();
});

it('the queue control displays the exact deleted count, removes those rows, then disappears', () => {
  setLibraryPresence([{ tracks: [tracks[0], tracks[4]] }]);
  localStorage.setItem('playerNowPlaying', JSON.stringify(tracks[0]));
  localStorage.setItem('playerQueue', JSON.stringify([tracks[1], tracks[4], tracks[1], tracks[2], tracks[4]]));
  render(<AudioPlayerProvider><PlayerTransport /></AudioPlayerProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Cola' }));
  fireEvent.click(screen.getByRole('button', { name: 'Quitar canciones eliminadas (3)' }));
  expect(screen.queryByRole('button', { name: /Quitar canciones eliminadas/ })).toBeNull();
  expect(document.querySelectorAll('.qrow')).toHaveLength(2);
  expect([...document.querySelectorAll('.qrow')].every(row => row.textContent?.includes('4'))).toBe(true);
});

it('a prefetched media 404 marks the next song absent without interrupting the current song', () => {
  setLibraryPresence([{ tracks }], 'one');
  const { result } = restore();
  act(() => engine.dispatchEvent(new CustomEvent('trackMissing', { detail: { key: tracks[1].relPath } })));
  expect(isTrackPresent(tracks[1])).toBe(false);
  expect(result.current.nowPlaying).toEqual(tracks[0]);
  expect(playbackNotice).not.toHaveBeenCalled();
  act(() => result.current.goNext());
  expect(result.current.nowPlaying).toEqual(tracks[2]);
});

it('four consecutive media 404s never spend the three-failure budget; the final 404 stops with one queue notice', async () => {
  setLibraryPresence([{ tracks: tracks.slice(0, 5) }], 'one');
  const { result } = renderHook(useAudioPlayer, { wrapper });
  act(() => result.current.setQueueWithTracks(tracks.slice(0, 5)));
  for (let index = 0; index < 4; index++) {
    await act(async () => { engine.error = { code: 2, status: 404 }; engine.dispatchEvent(new Event('error')); await flush(); });
    expect(isTrackPresent(tracks[index])).toBe(false);
  }
  expect(engine.load).toHaveBeenCalledTimes(5);
  expect(result.current.nowPlaying).toEqual(tracks[4]);
  expect(playbackNotice).not.toHaveBeenCalled();
  await act(async () => { engine.error = { code: 2, status: 404 }; engine.dispatchEvent(new Event('error')); await flush(); });
  expect(result.current.isPlaying).toBe(false);
  expect(playbackNotice).toHaveBeenCalledExactlyOnceWith('empty', '');
});
