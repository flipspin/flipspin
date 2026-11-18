import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import type { SchemaMacWorker } from '../api/generated/schema';
import type { LyricsEngine } from './lyricsStore';
import { useStemEngine } from './useStemEngine';

const mocks = vi.hoisted(() => ({
  engine: null as Partial<LyricsEngine> | null,
  unwatch: vi.fn(),
  watchJobs: vi.fn(),
  refreshMac: vi.fn(),
}));
vi.mock('./lyricsStore', () => ({
  useLyricsJobs: () => ({ engine: mocks.engine }),
  watchJobs: mocks.watchJobs,
}));
vi.mock('./macEngine', () => ({
  refreshMac: mocks.refreshMac,
  useMacEngine: () => ({ available: false, status: null, lastError: null }),
}));
const helper: SchemaMacWorker = {
  id: 'helper', name: 'Studio', nest: false, os: 'macos', accel: 'mlx', memoryBytes: 16 * 2 ** 30,
  jobs: ['stems'], state: 'idle', keepAwake: 'none', lastSeenAt: 1, version: '0.12.0', minimumVersion: '0.10.0', versionState: 'update',
};

beforeEach(async () => {
  vi.clearAllMocks();
  mocks.watchJobs.mockReturnValue(mocks.unwatch);
  mocks.engine = { mode: 'agent', helpers: [helper] };
  await i18n.changeLanguage('en');
});
afterEach(async () => { await i18n.changeLanguage('es'); });

it('uses measured Stems speed and the Stems-capable helper from the shared engine data', () => {
  mocks.engine = { mode: 'agent', helpers: [
    { ...helper, id: 'align', name: 'Alignment', jobs: ['align'] },
    { ...helper, name: 'Separation', speed: { stems: { samples: 3, medianSecondsPerMinute: 6 } } },
  ] };
  const { result, rerender } = renderHook(({ duration }) => useStemEngine(duration, true), { initialProps: { duration: 190 } });
  expect(result.current).toEqual({ available: true, machine: 'Separation', backend: 'MLX', estimate: 19 });
  rerender({ duration: 120 });
  expect(result.current.estimate).toBe(12);
});

it.each([
  ['mlx', 190, 20],
  ['cuda', 380, 40],
  ['cpu', 95, 75],
  ['cpu', undefined, 150],
] as const)('uses the %s Stems baseline for duration %s', (accel, duration, estimate) => {
  mocks.engine = { mode: 'agent', helpers: [{ ...helper, accel }] };
  const { result } = renderHook(() => useStemEngine(duration, true));
  expect(result.current).toEqual({ available: true, machine: 'Studio', backend: accel.toUpperCase(), estimate });
});

it('is unavailable when helpers only support Lyrics', () => {
  mocks.engine = { mode: 'agent', helpers: [{ ...helper, jobs: ['align'] }] };
  const { result } = renderHook(() => useStemEngine(190, true));
  expect(result.current).toEqual({ available: false, machine: undefined, backend: undefined, estimate: null });
});

it('treats the local Stems add-on independently of Lyrics', () => {
  mocks.engine = { mode: 'local', installed: true, addons: { lyrics: { ready: false }, stems: { ready: true } } } as LyricsEngine;
  const { result } = renderHook(() => useStemEngine(190, true));
  expect(result.current).toEqual({ available: true, machine: 'Nest', backend: undefined, estimate: null });
});

it('watches jobs and refreshes Mac state only while active, releasing the watcher on hide and unmount', () => {
  const { rerender, unmount } = renderHook(({ active }) => useStemEngine(190, active), { initialProps: { active: false } });
  expect(mocks.watchJobs).not.toHaveBeenCalled();
  expect(mocks.refreshMac).not.toHaveBeenCalled();
  rerender({ active: true });
  expect(mocks.watchJobs).toHaveBeenCalledTimes(1);
  expect(mocks.refreshMac).toHaveBeenCalledTimes(1);
  rerender({ active: false });
  expect(mocks.unwatch).toHaveBeenCalledTimes(1);
  rerender({ active: true });
  unmount();
  expect(mocks.watchJobs).toHaveBeenCalledTimes(2);
  expect(mocks.refreshMac).toHaveBeenCalledTimes(2);
  expect(mocks.unwatch).toHaveBeenCalledTimes(2);
});
