import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { bridge, setFakeBridgeForTest } from '../bridge';
import { installFakeBackend, type FakeBackend } from '../data/test-support';
import { serverStatus } from '../settings/test-support';
import type { OfflinePin } from '../lib/ipc';
import { cacheDocument, readLocal, queueDocument } from './localLyrics';
import i18n from '../i18n';
import { __resetLyricsStoreForTest, initializeLocalLyrics, loadLyrics, setLocalLyricsEnabled, useLyricsOverlayRelPath } from './lyricsStore';

const connection = vi.hoisted(() => ({ offline: false, listeners: new Set<() => void>() }));
vi.mock('../connection/connection', () => ({ connectionStore: {
  getSnapshot: () => ({ kind: 'ready', value: { connection: { state: connection.offline ? 'unreachable' : 'connected' } } }),
  subscribe: (fn: () => void) => { connection.listeners.add(fn); return () => connection.listeners.delete(fn); },
} }));
vi.mock('./lyricStates', () => ({ offlineLyricStates: async () => Object.fromEntries(pins.flatMap(pin => pin.tracks).map(key => [key, lyricStates[key] ?? 'synced'])) }));
let lyricStates: Record<string, string>;
let backend: FakeBackend;
let restore: () => void;
let backendKey: string;
let instanceId: string;
let pins: OfflinePin[];
let events: Map<string, Set<() => void>>;
let stallNetwork = false;
let invoke: ReturnType<typeof vi.fn>;
const path = 'Album/Song.mp3';
const doc = { relPath: path, kind: 'synced', text: '[00:01.00]Words', offsetMs: 0, source: 'manual', fetchedAt: 1, edited: true, revision: 'r1' };
function pin(key = path) { pins.push({ id: key, kind: 'song', ref: key, tracks: [key] }); }
function changed() { events.get('offline:changed')?.forEach(fn => (fn as (value: unknown) => void)({ pins: true })); }
function reconnect() { connection.offline = false; connection.listeners.forEach(fn => fn()); }
const scope = () => JSON.stringify([backendKey, 'user']);

beforeEach(() => {
  connection.offline = false; stallNetwork = false; lyricStates = {};
  backendKey = `https://example.com/${crypto.randomUUID()}`;
  instanceId = crypto.randomUUID(); pins = []; events = new Map();
  backend = installFakeBackend({ respond: req => stallNetwork ? new Promise(() => {}) : connection.offline ? { networkError: "offline" } : ({ status: 200, json: { ...doc, relPath: decodeURIComponent(req.pathname.split('/').slice(-2).join('/')) } }) });
  const current = bridge();
  invoke = vi.fn(async (channel: string, args: unknown) => {
    if (channel === 'app:get-backend-origin') return { origin: 'https://example.org', backendKey, instanceId };
    if (channel === 'auth:get') return { userId: 'user', hasToken: true };
    if (channel === 'server:get-status') {
      if (connection.offline) throw new Error('status unavailable');
      return serverStatus({ instanceId });
    }
    if (channel === 'offline:pools') return { pins };
    return current.invoke(channel as Parameters<typeof current.invoke>[0], args as never);
  });
  restore = setFakeBridgeForTest({ ...current, invoke: invoke as typeof current.invoke,
    on: (channel, listener) => {
      const fn = () => listener(undefined as never);
      const listeners = events.get(channel) ?? new Set(); events.set(channel, listeners); listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  });
});
afterEach(() => {
  vi.useRealTimers(); vi.restoreAllMocks(); localStorage.removeItem('krobi.localLyrics');
  __resetLyricsStoreForTest(); restore(); backend.restore(); connection.listeners.clear();
});

describe('lyrics for offline songs', () => {
  it('shares initialization and keeps one watcher after repeated calls and auth changes', async () => {
    await setLocalLyricsEnabled(true);
    const first = initializeLocalLyrics();
    expect(initializeLocalLyrics()).toBe(first);
    await first;
    await waitFor(() => expect(connection.listeners.size).toBe(1));
    const subscriptions = events.get('offline:changed')?.size;
    events.get('auth:changed')?.forEach(fn => fn());
    await initializeLocalLyrics();
    await waitFor(() => expect(events.get('offline:changed')?.size).toBe(subscriptions));
    expect(connection.listeners.size).toBe(1);
  });
  it('fetches only positive lyric states and respects the durable none memo', async () => {
    for (const key of ['Plain', 'Pending', 'None', 'Instrumental', 'Queued', 'Memo']) pin(`Album/${key}.mp3`);
    lyricStates = { 'Album/Plain.mp3': 'plain', 'Album/Pending.mp3': 'pending', 'Album/None.mp3': 'none', 'Album/Instrumental.mp3': 'instrumental', 'Album/Queued.mp3': 'queued' };
    await cacheDocument(scope(), 'Album/Memo.mp3', null, false, { checkedAt: Date.now(), etag: '"none"' });
    await setLocalLyricsEnabled(true);
    await waitFor(async () => expect((await readLocal(scope(), 'Album/Plain.mp3'))?.offlineCached).toBe(true));
    await waitFor(async () => expect((await readLocal(scope(), 'Album/Memo.mp3'))?.offlineCached).toBe(true));
    expect(backend.requests.map(req => req.pathname)).toEqual(['/api/lyrics/Album/Plain.mp3']);
  });
  it('opens an online cache after restart offline, without requesting server status', async () => {
    await setLocalLyricsEnabled(true);
    await loadLyrics(path);
    __resetLyricsStoreForTest(); connection.offline = true; invoke.mockClear();
    expect(await loadLyrics(path)).toEqual(doc);
    expect(invoke).not.toHaveBeenCalledWith('server:get-status', undefined);
    expect(await initializeLocalLyrics()).toBe(scope());
  });
  it('migrates instance-id rows while offline without crossing accounts', async () => {
    await cacheDocument(JSON.stringify([instanceId, 'user']), path, doc);
    await cacheDocument(JSON.stringify([instanceId, 'someone-else']), 'Album/Private.mp3', doc);
    connection.offline = true;
    await setLocalLyricsEnabled(true);
    expect(await loadLyrics(path)).toEqual(doc);
    expect(await readLocal(scope(), path)).toMatchObject({ doc });
    expect(await readLocal(scope(), 'Album/Private.mp3')).toBeUndefined();
  });
  it('caches lyrics when a song is pinned without opening its lyrics', async () => {
    await setLocalLyricsEnabled(true);
    pin(); changed();
    await waitFor(async () => expect(await readLocal(scope(), path)).toMatchObject({ doc }));
  });
  it('caches earlier downloads when enabled and resumes after restart', async () => {
    pin();
    await setLocalLyricsEnabled(true);
    await waitFor(async () => expect(await readLocal(scope(), path)).toMatchObject({ doc }));
    __resetLyricsStoreForTest(); pin('Album/Second.mp3');
    const shell = renderHook(useLyricsOverlayRelPath);
    expect(shell.result.current).toBeNull();
    await waitFor(async () => expect(await readLocal(scope(), 'Album/Second.mp3')).toBeDefined());
    shell.unmount();
    expect(backend.countFor('/api/lyrics/Album/Song.mp3')).toBe(1);
  });
  it('defers downloads while offline and resumes on reconnect', async () => {
    connection.offline = true; pin();
    await setLocalLyricsEnabled(true);
    expect(backend.requests).toHaveLength(0);
    reconnect();
    await waitFor(async () => expect(await readLocal(scope(), path)).toMatchObject({ doc }));
  });
  it('answers cached and missing lyrics offline without advancing network timeout timers', async () => {
    await cacheDocument(scope(), path, doc);
    connection.offline = true;
    stallNetwork = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await setLocalLyricsEnabled(true);
    expect(await loadLyrics(path, { force: true })).toEqual(doc);
    expect(await loadLyrics('Album/Missing.mp3')).toBeNull();
    expect(backend.requests).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a download pass to three requests and retains plain lyrics and missing results', async () => {
    const original = globalThis.fetch;
    const releases: (() => void)[] = [];
    let active = 0, maximum = 0;
    globalThis.fetch = async (input, init) => {
      active++; maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => releases.push(resolve));
      active--;
      return original(input, init);
    };
    for (let n = 0; n < 7; n++) pin(`Album/${n}.mp3`);
    await setLocalLyricsEnabled(true);
    await waitFor(() => expect(releases).toHaveLength(3));
    expect(backend.requests).toHaveLength(0);
    releases.splice(0).forEach(resolve => resolve());
    await waitFor(() => expect(releases).toHaveLength(3));
    releases.splice(0).forEach(resolve => resolve());
    await waitFor(() => expect(releases).toHaveLength(1));
    releases.splice(0).forEach(resolve => resolve());
    await waitFor(async () => expect(await readLocal(scope(), 'Album/6.mp3')).toBeDefined());
    expect(maximum).toBe(3);
    globalThis.fetch = async () => new Response(JSON.stringify({ ...doc, kind: 'plain', text: 'Plain words' }), { headers: { 'content-type': 'application/json' } });
    pin('Album/Plain.mp3'); changed();
    await waitFor(async () => expect((await readLocal(scope(), 'Album/Plain.mp3'))?.doc).toMatchObject({ kind: 'plain', text: 'Plain words' }));
    globalThis.fetch = async () => new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    pin('Album/Instrumental.mp3'); changed();
    await waitFor(async () => expect((await readLocal(scope(), 'Album/Instrumental.mp3'))?.doc).toBeNull());
  });
  it('does not commit background lyrics after disabling', async () => {
    let release!: () => void;
    let started = false, finished = false;
    globalThis.fetch = async () => {
      started = true;
      await new Promise<void>(resolve => { release = resolve; });
      finished = true;
      return new Response(JSON.stringify(doc), { headers: { 'content-type': 'application/json' } });
    };
    pin(); await setLocalLyricsEnabled(true);
    await waitFor(() => expect(started).toBe(true));
    await setLocalLyricsEnabled(false);
    release();
    // Let the late response finish before checking the durable store.
    await waitFor(() => expect(finished).toBe(true));
    expect(await readLocal(scope(), path)).toBeUndefined();
  });
  it('blocks disabling migrated pending edits and translates at call time', async () => {
    connection.offline = true;
    await queueDocument(JSON.stringify([instanceId, 'user']), path, { ...doc, text: 'Pending words' }, doc);
    await setLocalLyricsEnabled(true);
    await expect(setLocalLyricsEnabled(false)).rejects.toThrow('Sincroniza');
    const language = i18n.language;
    try {
      await i18n.changeLanguage('en');
      await expect(setLocalLyricsEnabled(false)).rejects.toThrow('Sync or discard local changes before turning this option off');
    } finally { await i18n.changeLanguage(language); }
  });

  it('bypasses an online request already waiting on the network when disconnected', async () => {
    let started = false;
    globalThis.fetch = () => { started = true; return new Promise<Response>(() => {}); };
    await setLocalLyricsEnabled(true);
    void loadLyrics(path);
    await waitFor(() => expect(started).toBe(true));
    await cacheDocument(scope(), path, doc);
    connection.offline = true;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect(await loadLyrics(path, { force: true })).toEqual(doc);
  });

  it('retries a failed download lyric without restarting completed work', async () => {
    let attempts = 0;
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (++attempts === 1) throw new TypeError('temporary outage');
      return original(input, init);
    };
    await cacheDocument(scope(), path, doc);
    pin(); await setLocalLyricsEnabled(true);
    await waitFor(() => expect(attempts).toBe(1));
    expect((await readLocal(scope(), path))?.offlineCached).not.toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15001);
    reconnect(); changed();
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(async () => expect(await readLocal(scope(), path)).toMatchObject({ doc, offlineCached: true }));
  });

  it('rechecks a previous online 404 when pinned and records durable background progress', async () => {
    await cacheDocument(scope(), path, null);
    pin(); await setLocalLyricsEnabled(true);
    await waitFor(async () => expect(await readLocal(scope(), path)).toMatchObject({ doc, offlineCached: true }));
    __resetLyricsStoreForTest();
    const subscribers = events.get('offline:changed')?.size ?? 0;
    const shell = renderHook(useLyricsOverlayRelPath);
    await waitFor(() => expect(events.get('offline:changed')?.size).toBeGreaterThan(subscribers));
    // A later pin proves the resumed pass ran, while the first GET stays completed.
    pin('Album/New.mp3'); changed();
    await waitFor(async () => expect((await readLocal(scope(), 'Album/New.mp3'))?.offlineCached).toBe(true));
    expect(backend.countFor('/api/lyrics/Album/Song.mp3')).toBe(1);
    shell.unmount();
  });

});
