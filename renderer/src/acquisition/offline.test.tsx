import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { setFakeBridgeForTest } from '../bridge';
import type { KrobiBridge, OfflineTrackStatus } from '../lib/ipc';
import { refreshOffline, useOfflineTrack } from './offline';

// The real identity store fetches /api/me on first subscribe; its failure
// lands at a random moment and clears the offline state mid-test (flaky).
vi.mock('@state/identityStore', () => ({ subscribe: () => () => {} }));

let restore: () => void;
afterEach(() => { restore?.(); vi.useRealTimers(); });

it('batches registrations and only renders the song whose offline snapshot changed', async () => {
  vi.useFakeTimers();
  let tracks: OfflineTrackStatus[] = [];
  const invoke = vi.fn(async () => ({ tracks: tracks.map(t => ({ ...t })) }));
  restore = setFakeBridgeForTest({ invoke, on: () => () => {} } as unknown as KrobiBridge);
  const renders = new Map<string, number>();
  function Song({ id }: { id: string }) {
    const file = useOfflineTrack(id);
    renders.set(id, (renders.get(id) || 0) + 1);
    return <span data-testid={id}>{file?.state || 'no descargado'}</span>;
  }
  const ids = Array.from({ length: 714 }, (_, i) => `song-${i}`);
  const view = render(<>{ids.map(id => <Song key={id} id={id} />)}</>);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenLastCalledWith('offline:status', { keys: ids });
  const file: OfflineTrackStatus = { key: ids[0], state: 'descargando', pool: 'offline', bytes: 0, etag: null, verifiedAt: null, lastPlayedAt: null, error: null };
  tracks = [file];
  await act(refreshOffline);
  expect(screen.getByTestId(ids[0])).toHaveTextContent('descargando');
  expect(renders.get(ids[0])).toBe(2);
  expect(renders.get(ids[1])).toBe(1);
  await act(refreshOffline); // Fresh IPC objects, identical fields.
  expect(renders.get(ids[0])).toBe(2);
  tracks = [];
  await act(refreshOffline);
  expect(screen.getByTestId(ids[0])).toHaveTextContent('no descargado');
  expect(renders.get(ids[0])).toBe(3);
  expect(renders.get(ids[1])).toBe(1);
  view.unmount();
  invoke.mockClear();
  await refreshOffline();
  expect(invoke).toHaveBeenLastCalledWith('offline:status', { keys: [] });
});

it('unregisters an old key when a row changes tracks', async () => {
  vi.useFakeTimers();
  const invoke = vi.fn(async () => ({ tracks: [] }));
  restore = setFakeBridgeForTest({ invoke, on: () => () => {} } as unknown as KrobiBridge);
  function Song({ id }: { id: string }) { useOfflineTrack(id); return null; }
  const view = render(<Song id="first" />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  view.rerender(<Song id="second" />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(invoke).toHaveBeenLastCalledWith('offline:status', { keys: ['second'] });
});
