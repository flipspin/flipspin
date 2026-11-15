import "fake-indexeddb/auto";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridge, setFakeBridgeForTest } from "../bridge";
import { installFakeBackend, type FakeBackend } from "../data/test-support";
import { cacheDocument, queueDocument, readLocal } from "./localLyrics";
import { refreshLyricStates, useLyricStates } from "./lyricStates";
import {
  __resetLyricsStoreForTest, getState, initializeLocalLyrics, loadLyrics,
  lyricsIndexChanged, refreshJobs, setLocalLyricsEnabled, subscribe,
} from "./lyricsStore";

const connection = vi.hoisted(() => ({ offline: false }));
vi.mock("../offline/policy", () => ({ isOfflineNow: () => connection.offline }));
const path = "Album/Song.mp3";
const url = "/api/lyrics/Album/Song.mp3";
const doc = { relPath: path, kind: "synced", text: "[00:01]Words", offsetMs: 0, source: "manual", fetchedAt: 1, edited: false, revision: "r1" };
let backend: FakeBackend;
let restoreIdentity: (() => void) | undefined;
let now: number;
let key: string;
let absent: boolean;
let indexRevision: string;
let indexState: string | undefined;
let done: number;
let conditionalBodies: number[];

beforeEach(() => {
  now = 1800000000000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  connection.offline = false; absent = false; indexRevision = "index-1"; indexState = undefined; done = 0;
  conditionalBodies = [];
  key = crypto.randomUUID();
  backend = installFakeBackend({ respond: req => {
    if (req.pathname === "/api/lyrics/states") return { status: 200, json: { states: { [path]: indexState ?? (absent ? "pending" : "synced") }, counts: {} } };
    if (req.pathname === "/api/lyrics/jobs") return { status: 200, json: { withLyrics: absent ? 0 : 1, pendingCount: absent ? 1 : 0, lastRun: { progressId: "job", total: 1, found: done, pending: 0, skipped: 0, errors: 0 } } };
    if (req.headers["if-none-match"] === (absent ? '"none"' : '"r1"')) return { status: 304 };
    return absent ? { status: 404, json: { detail: "No lyrics" } } : { status: 200, json: doc };
  } });
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await fetch(input, init);
    const pathname = new URL((input as Request).url).pathname;
    response.headers.set("ETag", pathname.endsWith("/states") ? `"${indexRevision}"` : absent ? '"none"' : '"r1"');
    if (response.status === 304) conditionalBodies.push((await response.clone().arrayBuffer()).byteLength);
    return response;
  };
  const current = bridge();
  restoreIdentity = setFakeBridgeForTest({ ...current, invoke: (async (channel, args) => {
    if (channel === "app:get-backend-origin") return { origin: "https://example.com", backendKey: key };
    if (channel === "auth:get") return { userId: "user", hasToken: true };
    if (channel === "offline:pools") return { pins: [] };
    return current.invoke(channel, args);
  }) as typeof current.invoke });
});
afterEach(() => {
  cleanup(); localStorage.removeItem("krobi.localLyrics"); __resetLyricsStoreForTest();
  restoreIdentity?.(); backend.restore(); vi.restoreAllMocks();
});

const requests = () => backend.countFor(url);
async function settle() { await new Promise(resolve => setTimeout(resolve, 10)); }

describe("lyrics revalidation", () => {
  it("hydrates queued edits from another window even when the server revision is unchanged", async () => {
    await setLocalLyricsEnabled(true); await loadLyrics(path);
    const scope = (await initializeLocalLyrics())!;
    await queueDocument(scope, path, { ...doc, text: "[00:01]Queued edit" }, doc);
    expect((await loadLyrics(path, { force: true }))?.text).toContain("Queued edit");
    expect(getState().docs[path]?.text).toContain("Queued edit");
    expect(requests()).toBe(1);
  });

  it("revalidates a durable copy with its revision and keeps the document and cache version on 304", async () => {
    await setLocalLyricsEnabled(true);
    const scope = (await initializeLocalLyrics())!;
    await cacheDocument(scope, path, doc);
    expect(await loadLyrics(path, { force: true })).toEqual(doc);
    const before = await readLocal(scope, path);
    const displayed = getState().docs[path];
    const listener = vi.fn(); const unsubscribe = subscribe(listener);
    expect(await loadLyrics(path, { force: true })).toBe(displayed);
    expect(backend.requests.at(-1)?.headers["if-none-match"]).toBe('"r1"');
    expect(conditionalBodies).toEqual([0, 0]);
    expect(getState().docs[path]).toBe(displayed);
    expect((await readLocal(scope, path))?.version).toBe(before?.version);
    expect(listener).not.toHaveBeenCalled(); unsubscribe();
  });

  it("revalidates positive copies at most once per ten minutes across plays and restarts", async () => {
    await setLocalLyricsEnabled(true);
    await loadLyrics(path);
    for (let n = 0; n < 4; n++) await loadLyrics(path);
    now += 10 * 60 * 1000 - 1;
    __resetLyricsStoreForTest();
    await loadLyrics(path); await settle();
    expect(requests()).toBe(1);
    now++;
    await loadLyrics(path);
    await waitFor(() => expect(requests()).toBe(2));
    await settle();
    for (let n = 0; n < 4; n++) await loadLyrics(path);
    expect(requests()).toBe(2);
  });

  it("remembers none for six hours across plays and restarts, then revalidates its ETag", async () => {
    absent = true; await setLocalLyricsEnabled(true);
    expect(await loadLyrics(path)).toBeNull();
    const scope = (await initializeLocalLyrics())!;
    expect(await readLocal(scope, path)).toMatchObject({ doc: null, validation: { etag: '"none"', checkedAt: now } });
    for (let n = 0; n < 4; n++) await loadLyrics(path);
    now += 6 * 60 * 60 * 1000 - 1;
    __resetLyricsStoreForTest();
    await loadLyrics(path); await settle();
    expect(requests()).toBe(1);
    now++; await loadLyrics(path);
    await waitFor(() => expect(requests()).toBe(2));
    await settle();
    expect(backend.requests.at(-1)?.headers["if-none-match"]).toBe('"none"');
    expect(conditionalBodies).toEqual([0]);
    await loadLyrics(path); expect(requests()).toBe(2);
  });

  it("rechecks none immediately when the polled index revision changes", async () => {
    absent = true;
    renderHook(useLyricStates);
    await waitFor(() => expect(backend.countFor("/api/lyrics/states")).toBe(1));
    await settle(); await loadLyrics(path);
    expect(requests()).toBe(1);
    await act(() => refreshLyricStates()); await settle();
    expect(requests()).toBe(1);
    indexRevision = "index-2"; absent = false;
    await act(() => refreshLyricStates());
    await waitFor(() => expect(getState().docs[path]).toEqual(doc));
    expect(requests()).toBe(2);
    expect(backend.requests.filter(req => req.pathname === url).at(-1)?.headers["if-none-match"]).toBe('"none"');
  });

  it("rechecks none when a polled jobs result changes", async () => {
    absent = true;
    await refreshJobs(); await loadLyrics(path);
    await refreshJobs(); await settle(); expect(requests()).toBe(1);
    done++;
    await refreshJobs();
    await waitFor(() => expect(requests()).toBe(2));
  });

  it("forces a positive refresh when the index reports that song's sync job finished", async () => {
    indexState = "queued";
    renderHook(useLyricStates); await settle();
    await loadLyrics(path); expect(requests()).toBe(1);
    indexState = "synced"; indexRevision = "index-2";
    await act(() => refreshLyricStates());
    await waitFor(() => expect(requests()).toBe(2));
  });

  it("does not lose an index change that arrives during a validation", async () => {
    absent = true; lyricsIndexChanged("index-1");
    await loadLyrics(path);
    const fetch = globalThis.fetch;
    let release!: () => void;
    globalThis.fetch = async (input, init) => {
      const response = await fetch(input, init);
      await new Promise<void>(resolve => { release = resolve; });
      return response;
    };
    const validating = loadLyrics(path, { force: true });
    await waitFor(() => expect(release).toBeDefined());
    lyricsIndexChanged("index-2");
    globalThis.fetch = fetch;
    release(); await validating;
    await waitFor(() => expect(requests()).toBe(3));
  });

  it("throttles failed revalidation without caching a server failure as none", async () => {
    await loadLyrics(path); now += 10 * 60 * 1000;
    const fetch = globalThis.fetch;
    let failures = 0;
    globalThis.fetch = async () => { failures++; return new Response('{}', { status: 503 }); };
    await expect(loadLyrics(path, { force: true })).rejects.toThrow("503");
    for (let n = 0; n < 4; n++) await loadLyrics(path);
    expect(getState().docs[path]).toEqual(doc); expect(failures).toBe(1);
    now += 10 * 60 * 1000; globalThis.fetch = fetch;
    await loadLyrics(path, { waitForRefresh: true });
    expect(requests()).toBe(2);
  });

  it("makes zero requests offline even for force, missing songs, and index changes", async () => {
    await setLocalLyricsEnabled(true);
    const scope = (await initializeLocalLyrics())!;
    await cacheDocument(scope, path, doc);
    connection.offline = true;
    expect(await loadLyrics(path, { force: true })).toEqual(doc);
    expect(await loadLyrics("Album/Missing.mp3", { force: true })).toBeNull();
    await refreshJobs(); renderHook(useLyricStates); await settle();
    expect(backend.requests).toHaveLength(0);
  });

  it("forced editor and completed-sync refreshes bypass both TTLs", async () => {
    await loadLyrics(path);
    await loadLyrics(path, { force: true }); expect(requests()).toBe(2);
    absent = true; await loadLyrics(path, { force: true });
    await loadLyrics(path); expect(requests()).toBe(3);
    await loadLyrics(path, { force: true }); expect(requests()).toBe(4);
  });

  it("deduplicates a background validation while cached text opens immediately", async () => {
    await loadLyrics(path); now += 10 * 60 * 1000;
    const fetch = globalThis.fetch;
    let finish!: () => void;
    globalThis.fetch = async (input, init) => { await new Promise<void>(resolve => { finish = resolve; }); return fetch(input, init); };
    expect(await loadLyrics(path)).toEqual(doc);
    for (let n = 0; n < 4; n++) expect(await loadLyrics(path)).toEqual(doc);
    const forced = loadLyrics(path, { force: true });
    finish(); await forced;
    expect(requests()).toBe(2);
  });
});
