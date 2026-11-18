import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FakeContext } from '../stems/fakeAudio';

beforeEach(() => { localStorage.clear(); vi.resetModules(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it('restores the same device volume in the engine and graph before the transport mounts', async () => {
  localStorage.setItem('krobi.outputVolume', '0.42');
  vi.stubGlobal('AudioContext', FakeContext);
  const { PlaybackEngine } = await import('./engine/PlaybackEngine');
  const { getAudioGraph, setGraphVolume } = await import('../stems/audioGraph');
  const { getVolume } = await import('./volumeStore');
  const first = new PlaybackEngine();
  const second = new PlaybackEngine();
  expect(first.volume).toBe(0.42);
  const graph = getAudioGraph();
  expect(graph.volume.gain.value).toBe(0.42);
  first.volume = 0.18;
  expect(second.volume).toBe(0.18);
  expect(getVolume()).toBe(0.18);
  expect(graph.volume.gain.value).toBe(0.18);
  setGraphVolume(0);
  expect(first.volume).toBe(0);
  expect(localStorage.getItem('krobi.outputVolume')).toBe('0');
});

it.each(['', 'bad', 'NaN', 'Infinity', '-0.5', '1.5'])('ignores invalid saved volume %j', async saved => {
  localStorage.setItem('krobi.outputVolume', saved);
  const { getVolume } = await import('./volumeStore');
  expect(getVolume()).toBe(1);
});

it('retains session volume when storage is unavailable and rejects non-finite input', async () => {
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('unavailable'); });
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('unavailable'); });
  const { getVolume, setVolume } = await import('./volumeStore');
  expect(getVolume()).toBe(1);
  setVolume(0.3);
  expect(getVolume()).toBe(0.3);
  setVolume(NaN);
  expect(getVolume()).toBe(0.3);
  setVolume(2);
  expect(getVolume()).toBe(1);
});
