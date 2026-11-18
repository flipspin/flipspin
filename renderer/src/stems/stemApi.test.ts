import { focusManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeBackend } from '../data/test-support';
import { deferred } from './fakeAudio';

let backend: FakeBackend | undefined;
const originalDesktop = Object.getOwnPropertyDescriptor(window, 'desktopAPI');
beforeEach(() => {
  vi.resetModules();
  Object.defineProperty(window, 'desktopAPI', { configurable: true, value: { backendUrl: 'http://nest:8000', mediaProxyUrl: 'krobi-media://localhost' } });
});
afterEach(() => {
  focusManager.setFocused(undefined);
  backend?.restore();
  backend = undefined;
  vi.unstubAllGlobals();
  if (originalDesktop) Object.defineProperty(window, 'desktopAPI', originalDesktop);
  else Reflect.deleteProperty(window, 'desktopAPI');
});
const body = { track: { duration: 180 }, stems: { drums: '/api/stems/a/f/drums', bass: '/api/stems/a/f/bass', other: '/api/stems/a/f/other', vocals: '/api/stems/a/f/vocals' } };

describe('production stem wire', () => {
  it('reads the manifest through the generated client with encoded identity and preserves 202/404 as not-ready', async () => {
    const { installFakeBackend } = await import('../data/test-support');
    let status = 200;
    backend = installFakeBackend({ origin: 'http://nest:8000', respond: () => ({ status, json: status === 200 ? body : { status: 'queued' } }) });
    const { getManifest } = await import('./stemApi');
    focusManager.setFocused(false);
    const track = { album: 'Artist∕Album name', file: 'a #1.mp3' };
    const controller = new AbortController();
    expect(await getManifest(track, controller.signal)).toEqual(body);
    expect(backend.requests[0].url).toBe('http://nest:8000/api/stems/Artist%E2%88%95Album%20name/a%20%231.mp3');
    for (status of [202, 404]) expect(await getManifest(track, controller.signal)).toBeNull();
    status = 403;
    await expect(getManifest(track, controller.signal)).rejects.toThrow('HTTP 403');
  });

  it('validates unknown manifest bodies instead of trusting a cast', async () => {
    const { installFakeBackend } = await import('../data/test-support');
    backend = installFakeBackend({ respond: () => ({ status: 200, json: { stems: {} } }) });
    const { getManifest } = await import('./stemApi');
    await expect(getManifest({ album: 'a', file: 'f' }, new AbortController().signal)).rejects.toThrow('Invalid stem manifest');
  });

  it('starts all four fetches in parallel through withMediaAccess with one AbortSignal', async () => {
    const { fetchStems } = await import('./stemApi');
    const response = deferred<Response>();
    const fetch = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const loading = fetchStems(body, controller.signal);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls.map(call => (call as unknown as [string])[0])).toEqual([
      'krobi-media://localhost/api/stems/a/f/drums',
      'krobi-media://localhost/api/stems/a/f/bass',
      'krobi-media://localhost/api/stems/a/f/other',
      'krobi-media://localhost/api/stems/a/f/vocals',
    ]);
    expect(fetch.mock.calls.every(call => (call as unknown as [string, RequestInit])[1].signal === controller.signal)).toBe(true);
    // Each fetch gets its own body, as on the wire.
    response.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(4) } as Response);
    expect(await loading).toHaveLength(4);
    controller.abort();
    expect(fetch.mock.calls.every(call => (call as unknown as [string, RequestInit])[1].signal.aborted)).toBe(true);
  });

  it('a stem 404 rejects the whole fetch', async () => {
    const { fetchStems } = await import('./stemApi');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));
    await expect(fetchStems(body, new AbortController().signal)).rejects.toThrow('HTTP 404');
  });

  it('reads every slice the media proxy hands out (206, 1 MiB at a time)', async () => {
    const { fetchStems } = await import('./stemApi');
    const file = new Uint8Array(2500).map((_, i) => i % 251);
    const SLICE = 1000;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const asked = (init?.headers as Record<string, string> | undefined)?.Range;
      const start = asked ? Number(/bytes=(\d+)-/.exec(asked)![1]) : 0;
      const end = Math.min(file.length, start + SLICE) - 1;
      return new Response(file.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${file.length}` } });
    });
    vi.stubGlobal('fetch', fetch);
    const buffers = await fetchStems(body, new AbortController().signal);
    expect(buffers).toHaveLength(4);
    for (const buffer of buffers) expect(new Uint8Array(buffer)).toEqual(file);
    // Three slices per stem: 0-999, 1000-1999, 2000-2499.
    expect(fetch).toHaveBeenCalledTimes(12);
  });

  it('fails a stem whose next slice does not continue where the last ended', async () => {
    const { fetchStems } = await import('./stemApi');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(10), { status: 206, headers: { 'Content-Range': 'bytes 0-9/30' } })));
    await expect(fetchStems(body, new AbortController().signal)).rejects.toThrow('incomplete media range');
  });

  it('uses the server media keys for nested paths', async () => {
    const { stemTrack } = await import('./stemApi');
    expect(stemTrack({ path: '/Music/Album/song.mp3', duration: 123 })).toEqual({ album: 'Album', file: 'song.mp3', duration: 123 });
    expect(stemTrack(null)).toBeNull();
  });
});
