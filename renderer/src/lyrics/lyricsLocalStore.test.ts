import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { waitFor } from "@testing-library/react";
import { bridge, setFakeBridgeForTest } from "../bridge";
import { installFakeBackend, type FakeBackend } from "../data/test-support";
import { __resetLyricsStoreForTest, getState, loadLyrics, saveLyrics, setLocalLyricsEnabled, initializeLocalLyrics, retryLocalLyrics, resolveLocalLyrics, transcribe } from "./lyricsStore";
import { readLocal } from "./localLyrics";

let backend: FakeBackend;
let restoreBridge: (() => void) | undefined;
afterEach(() => {
  localStorage.removeItem("krobi.localLyrics");
  __resetLyricsStoreForTest(); restoreBridge?.(); backend?.restore();
});
function identity() {
  const current = bridge();
  const key = crypto.randomUUID();
  restoreBridge = setFakeBridgeForTest({ ...current, invoke: (async (channel, args) => {
    if (channel === "app:get-backend-origin") return { origin: "https://example.com", backendKey: key, instanceId: key };
    if (channel === "offline:pools") return { pins: [] };
    if (channel === "auth:get") return { userId: "user1", label: "User", hasToken: true };
    if (channel === "server:get-status") return current.invoke(channel, args);
    return current.invoke(channel, args);
  }) as typeof current.invoke });
}
const base = { relPath: "Album/Song.mp3", kind: "synced", text: "[00:01.00]Original", source: "manual", fetchedAt: 1, edited: true, revision: "r1" };
describe("local cache store integration", () => {
  it("commits offline edits durably, preserves them on forced refresh, and prevents disabling before sync", async () => {
    let offline = false;
    backend = installFakeBackend({ respond: () => offline ? { networkError: "offline" } : { status: 200, json: base } });
    identity();
    await setLocalLyricsEnabled(true);
    const scope = (await initializeLocalLyrics())!;
    await loadLyrics(base.relPath);
    offline = true;
    const saved = await saveLyrics(base.relPath, { ...base, text: "[00:02.00]Mine", force: true });
    expect(saved.text).toContain("Mine");
    expect((await readLocal(scope, base.relPath))?.pending?.text).toBe(saved.text);
    expect((await loadLyrics(base.relPath, { force: true }))?.text).toBe(saved.text);
    await expect(setLocalLyricsEnabled(false)).rejects.toThrow("Sincroniza");
  });
  it("uploads after reconnect and releases the pending local edit", async () => {
    backend = installFakeBackend({ respond: (request) => ({ status: 200, json: request.method === "PUT" ? { ...base, text: "mine\n", revision: "r2" } : base }) });
    identity(); await setLocalLyricsEnabled(true);
    const scope = (await initializeLocalLyrics())!;
    await loadLyrics(base.relPath);
    await saveLyrics(base.relPath, { ...base, text: "mine", force: true });
    retryLocalLyrics();
    await waitFor(async () => expect((await readLocal(scope, base.relPath))?.pending).toBeNull());
    expect(getState().docs[base.relPath]?.text).toBe("mine\n");
    await setLocalLyricsEnabled(false);
  });
  it("waits for an in-flight upload before choosing the server version", async () => {
    let remote = base;
    let uploading = false;
    let finish!: () => void;
    const upload = new Promise<void>((resolve) => { finish = resolve; });
    backend = installFakeBackend({ respond: async (request) => {
      if (request.method === "PUT") {
        uploading = true;
        await upload;
        remote = { ...base, text: "first", revision: "r2" };
      }
      return { status: 200, json: remote };
    } });
    identity(); await setLocalLyricsEnabled(true);
    const scope = (await initializeLocalLyrics())!;
    await loadLyrics(base.relPath);
    await saveLyrics(base.relPath, { ...base, text: "first", force: true });
    retryLocalLyrics();
    await waitFor(() => expect(uploading).toBe(true));
    await saveLyrics(base.relPath, { ...base, text: "second", force: true });
    const resolving = resolveLocalLyrics(base.relPath, false);
    finish();
    await resolving;
    expect(await readLocal(scope, base.relPath)).toMatchObject({ pending: null, status: "synced", doc: { text: "first", revision: "r2" } });
  });
  it("refuses alignment while offline changes are still queued", async () => {
    let offline = false;
    backend = installFakeBackend({ respond: () => offline ? { networkError: "offline" } : { status: 200, json: base } });
    identity(); await setLocalLyricsEnabled(true);
    await loadLyrics(base.relPath);
    await saveLyrics(base.relPath, { ...base, text: "mine", force: true });
    offline = true;
    await expect(transcribe([{ relPath: base.relPath }])).rejects.toThrow("Sincroniza");
    expect(backend.countFor("/api/lyrics/transcribe")).toBe(0);
  });
});
