import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeBackend, type FakeBackend } from "../data/test-support";
import { __resetLyricsStoreForTest, getState, openLyricsOrAdd, transcribe } from "./lyricsStore";
let backend: FakeBackend | null = null;
afterEach(() => { backend?.restore(); backend = null; __resetLyricsStoreForTest(); });
describe("lyrics HTTP contract", () => {
  it("serializes known text through the generated client, without dropping it", async () => {
    backend = installFakeBackend({ respond: (req) => ({ status: 200, json: req.url.endsWith("/transcribe") ? { progressId: "p", total: 1 } : {} }) });
    let body: unknown;
    const respond = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const request = input as Request;
      if (request.url.endsWith("/transcribe")) body = await request.clone().json();
      return respond(input, init);
    };
    await transcribe([{ relPath: "Artist∕Album/Disc∕Song.mp3", text: "First\n\nLast" }]);
    const request = backend.requests.find((r) => r.url.endsWith("/transcribe"));
    expect(request?.method).toBe("POST");
    expect(body).toEqual({ tracks: [{ album: "Artist∕Album", file: "Disc∕Song.mp3", text: "First\n\nLast" }], isolateVocals: true });
  });
  it("opens the permanent lyrics view even when a song has no words", async () => {
    backend = installFakeBackend({ respond: () => ({ status: 404, json: { detail: "not found" } }) });
    await openLyricsOrAdd("Album/Song.mp3");
    expect(getState().overlayRelPath).toBe("Album/Song.mp3");
    expect(getState().modalRelPath).toBeNull();
    await waitFor(() => expect(getState().docs["Album/Song.mp3"]).toBeNull());
  });
});

it("stages a selection at the align route, with save authority and no current PUT", async () => {
  const { alignLyrics } = await import("./lyricsStore");
  backend = installFakeBackend({ respond: req => ({ status: 200, json: req.url.endsWith("/align") ? { progressId: "p", total: 1 } : {} }) });
  let body: unknown;
  const respond = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if ((input as Request).url.endsWith("/align")) body = await (input as Request).clone().json();
    return respond(input, init);
  };
  await alignLyrics("Artist∕Album/Disc∕Song.mp3", { kind: "plain", text: "Known words", source: "genius", force: true, expectedRevision: "r1" });
  expect(body).toEqual({ album: "Artist∕Album", file: "Disc∕Song.mp3", kind: "plain", text: "Known words", source: "genius", edited: false, force: true, expectedRevision: "r1" });
  expect(backend.requests.some(req => req.method === "PUT")).toBe(false);
});

it("serializes renderer Undo metadata and conditional deletion through the generated client", async () => {
  const { saveLyrics, deleteLyrics } = await import("./lyricsStore");
  backend = installFakeBackend({ respond: () => ({ status: 200, json: {} }) });
  let body: unknown;
  const respond = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if ((input as Request).method === "PUT") body = await (input as Request).clone().json();
    return respond(input, init);
  };
  const restore = { fetchedAt: 42, result: { timingSource: "aligned:mms-fa" }, lineConfidence: [0.8], lowLines: [0] };
  await saveLyrics("Album/Song.mp3", { kind: "synced", text: "[00:01]Original", source: "genius", restore, force: true, expectedRevision: "r2" });
  expect(body).toMatchObject({ restore, force: true, expectedRevision: "r2" });
  await deleteLyrics("Album/Song.mp3", "r3");
  const request = backend.requests.find(req => req.method === "DELETE");
  expect(new URL(request!.url).searchParams.get("expectedRevision")).toBe("r3");
});


it("installs the account reset with local lyrics off before any document reads", async () => {
  const { initializeLocalLyrics, openLyricsModal } = await import("./lyricsStore");
  localStorage.setItem("krobi.localLyrics", "0");
  __resetLyricsStoreForTest();
  backend = installFakeBackend({ respond: () => ({ status: 404 }) });
  expect(await initializeLocalLyrics()).toBeNull();
  openLyricsModal("Album/Song.mp3");
  backend.emitAuthChanged({ userId: "next-account" });
  expect(getState()).toMatchObject({ docs: {}, overlayRelPath: null, modalRelPath: null, jobs: null });
  expect(backend.requests).toHaveLength(0);
});

it("clears cached docs and in-flight reads on account change with local lyrics off", async () => {
  const { initializeLocalLyrics, loadLyrics } = await import("./lyricsStore");
  localStorage.setItem("krobi.localLyrics", "0");
  __resetLyricsStoreForTest();
  let finish!: (value: { status: number; json: object }) => void;
  backend = installFakeBackend({ respond: req => req.pathname.includes("Slow")
    ? new Promise(resolve => { finish = resolve; })
    : { status: 200, json: { text: "Previous account words", kind: "plain" } } });
  await initializeLocalLyrics();
  await loadLyrics("Album/Song.mp3");
  const old = loadLyrics("Album/Slow.mp3");
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  backend.emitAuthChanged({ userId: "next-account" });
  expect(getState().docs).toEqual({});
  finish({ status: 200, json: { text: "Stale words", kind: "plain" } });
  await old.catch(() => {});
  expect(getState().docs).toEqual({});
  expect((await loadLyrics("Album/Song.mp3"))?.text).toBe("Previous account words");
  expect(backend.countFor("/api/lyrics/Album/Song.mp3")).toBe(2);
});
