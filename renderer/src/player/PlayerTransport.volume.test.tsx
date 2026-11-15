import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const engine = vi.hoisted(() => ({ current: Object.assign(new EventTarget(), { volume: 1 }) }));
vi.mock('@state/AudioPlayerContext', () => ({
  useAudioPlayer: () => ({ audioRef: engine, selectedTrack: null, queue: [] }),
  useAudioProgress: () => ({ progress: 0, duration: 0 }),
}));
vi.mock('@state/AudioAnalyzerContext', () => ({ useAudioAnalyzer: () => ({}) }));
vi.mock('../state/useStatus', () => ({ useStatus: () => ({ showSuccess: vi.fn(), showError: vi.fn() }) }));
vi.mock('../library/tracks/useAddToPlaylistMenu', () => ({ useAddToPlaylistMenu: () => ({ refresh: vi.fn(), submenu: () => [] }) }));
vi.mock('../lyrics/lyricsStore', () => ({ lyricsKeyOf: () => null, useHasLyrics: () => false }));
vi.mock('../library/tracks/useSongMenu', () => ({ useSongMenu: () => ({ build: () => [] }) }));
vi.mock('../lyrics/LyricsModal', () => ({ default: () => null }));

beforeEach(() => { localStorage.clear(); vi.resetModules(); engine.current.volume = 1; });
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
const slider = () => screen.getByRole('slider', { name: 'Volumen' });
function changeVolume(value: number) {
  vi.spyOn(slider(), 'getBoundingClientRect').mockReturnValue({ left: 0, width: 100 } as DOMRect);
  fireEvent.pointerDown(slider(), { clientX: value * 100, pointerId: 1 });
  fireEvent.pointerUp(slider(), { pointerId: 1 });
}

// Cold-loads the transport module, then renders and remounts its full controls.
it('retains device volume across an identity-keyed transport remount', async () => {
  const { default: PlayerTransport } = await import('./PlayerTransport');
  const view = render(<PlayerTransport key="first-account" />);
  changeVolume(0.37);
  expect(slider()).toHaveAttribute('aria-valuenow', '37');
  view.rerender(<PlayerTransport key="next-account" />);
  expect(slider()).toHaveAttribute('aria-valuenow', '37');
  expect(engine.current.volume).toBeCloseTo(0.37);
}, 20000);

it.each([0, 0.42])('restores device volume %s on a fresh module load', async volume => {
  let { default: PlayerTransport } = await import('./PlayerTransport');
  const view = render(<PlayerTransport />);
  changeVolume(volume);
  view.unmount();
  vi.resetModules(); // launch: discard singleton memory, retain device storage
  ({ default: PlayerTransport } = await import('./PlayerTransport'));
  render(<PlayerTransport />);
  expect(slider()).toHaveAttribute('aria-valuenow', String(volume * 100));
  expect(engine.current.volume).toBe(volume);
});

it('persists engine volume changes as well as the slider', async () => {
  const { default: PlayerTransport } = await import('./PlayerTransport');
  const view = render(<PlayerTransport />);
  act(() => { engine.current.volume = 0.23; engine.current.dispatchEvent(new Event('volumechange')); });
  expect(slider()).toHaveAttribute('aria-valuenow', '23');
  view.unmount();
  vi.resetModules();
  const { default: ReloadedTransport } = await import('./PlayerTransport');
  render(<ReloadedTransport />);
  expect(slider()).toHaveAttribute('aria-valuenow', '23');
});
