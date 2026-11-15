import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { cacheDocument, listLocal, queueDocument, queueOffset, readLocal, syncLocal, updateLocal, type SyncTransport } from "./localLyrics";
import type { LyricsDoc, SavePayload } from "./lyricsStore";

const path = "Album/Song.mp3";
const base = { relPath: path, kind: "synced", text: "[00:05.00]Hello", source: "manual", edited: true, fetchedAt: 1, revision: "r1" } as LyricsDoc;
const edit = (text: string): SavePayload => ({ kind: "synced", text, source: "manual", edited: true, force: true });
let id = 0;
const scope = () => `server-user-${++id}`;
function transport(remote = base): SyncTransport {
  return {
    get: vi.fn(async () => remote),
    put: vi.fn(async (_path, payload) => ({ ...remote, ...payload, revision: "r2" })),
    offset: vi.fn(async (_path, offsetMs) => ({ ...remote, offsetMs, revision: "r2" })),
    changed: vi.fn(), active: () => true,
    conflict: (e) => e === "conflict", blocked: (e) => e === "blocked",
  };
}

describe("durable local lyrics", () => {
  it("stores cached lyrics and isolates servers/accounts", async () => {
    const a = scope(), b = scope();
    await cacheDocument(a, path, base);
    expect((await readLocal(a, path))?.doc).toEqual(base);
    expect(await readLocal(b, path)).toBeUndefined();
  });
  it("coalesces repeated edits into one durable row, preserving the original revision", async () => {
    const s = scope();
    await cacheDocument(s, path, base);
    await queueDocument(s, path, edit("first"), base);
    await queueDocument(s, path, edit("latest"), base);
    const rows = await listLocal(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ revision: "r1", status: "local", pending: { text: "latest" }, doc: { text: "latest" } });
  });
  it("does not overwrite queued work with a cache refresh", async () => {
    const s = scope();
    await queueDocument(s, path, edit("mine"), base);
    await cacheDocument(s, path, { ...base, text: "server" });
    expect((await readLocal(s, path))?.doc?.text).toBe("mine");
  });
  it("retains edits on a network failure and retries conditionally", async () => {
    const s = scope(), t = transport();
    await queueDocument(s, path, edit("mine"), base);
    vi.mocked(t.put).mockRejectedValueOnce(new Error("offline"));
    await syncLocal(s, t);
    expect((await readLocal(s, path))?.status).toBe("local");
    await syncLocal(s, t);
    expect(t.put).toHaveBeenLastCalledWith(path, expect.objectContaining({ text: "mine", expectedRevision: "r1" }));
    expect(await readLocal(s, path)).toMatchObject({ pending: null, status: "synced", revision: "r2" });
  });
  it("stops rather than overwriting a newer server revision", async () => {
    const s = scope(), t = transport({ ...base, revision: "newer", text: "theirs" });
    await queueDocument(s, path, edit("mine"), base);
    await syncLocal(s, t);
    expect(t.put).not.toHaveBeenCalled();
    expect(await readLocal(s, path)).toMatchObject({ status: "conflict", pending: { text: "mine" } });
    await syncLocal(s, t);
    expect(t.get).toHaveBeenCalledTimes(1);
  });
  it("handles an atomic server conflict after the GET", async () => {
    const s = scope(), t = transport();
    await queueDocument(s, path, edit("mine"), base);
    vi.mocked(t.put).mockRejectedValue("conflict");
    await syncLocal(s, t);
    expect((await readLocal(s, path))?.status).toBe("conflict");
  });
  it("recognises a successful write whose response was lost", async () => {
    const s = scope(), t = transport({ ...base, text: "mine", revision: "r2" });
    await queueDocument(s, path, edit("mine"), base);
    await syncLocal(s, t);
    expect(t.put).not.toHaveBeenCalled();
    expect(await readLocal(s, path)).toMatchObject({ pending: null, revision: "r2" });
  });
  it("preserves edits made during an in-flight request and rebases the next conditional save", async () => {
    const s = scope(), t = transport();
    await queueDocument(s, path, edit("first"), base);
    vi.mocked(t.put).mockImplementationOnce(async () => {
      await queueDocument(s, path, edit("second"), base);
      return { ...base, text: "first", revision: "r2" };
    });
    await syncLocal(s, t);
    expect(await readLocal(s, path)).toMatchObject({ pending: { text: "second" }, doc: { text: "second" }, revision: "r2", status: "local" });
  });
  it("does not upload an edit discarded while reading the server", async () => {
    const s = scope(), t = transport();
    await queueDocument(s, path, edit("discard me"), base);
    t.get = async () => {
      await updateLocal(s, path, (row) => ({ ...row!, doc: base, pending: null, status: "synced", version: row!.version + 1 }));
      return base;
    };
    await syncLocal(s, t);
    expect(t.put).not.toHaveBeenCalled();
    expect(await readLocal(s, path)).toMatchObject({ pending: null, doc: base, status: "synced" });
  });
  it("defers an obsolete snapshot when a newer edit arrives during the GET", async () => {
    const s = scope(), t = transport();
    await queueDocument(s, path, edit("first"), base);
    vi.mocked(t.get).mockImplementationOnce(async () => {
      await queueDocument(s, path, edit("second"), base);
      return base;
    });
    await syncLocal(s, t);
    expect(t.put).not.toHaveBeenCalled();
    await syncLocal(s, t);
    expect(t.put).toHaveBeenCalledExactlyOnceWith(path, expect.objectContaining({ text: "second", expectedRevision: "r1" }));
  });
  it("blocks unsafe uploads to servers without revision support", async () => {
    const s = scope(), t = transport({ ...base, revision: undefined });
    await queueDocument(s, path, edit("mine"), base);
    await syncLocal(s, t);
    expect(t.put).not.toHaveBeenCalled();
    expect((await readLocal(s, path))?.status).toBe("blocked");
  });
  it("does not send work after the account changes during a GET", async () => {
    const s = scope(), t = transport();
    await queueDocument(s, path, edit("mine"), base);
    let active = true;
    t.active = () => active;
    t.get = async () => { active = false; return base; };
    await syncLocal(s, t);
    expect(t.put).not.toHaveBeenCalled();
    expect((await readLocal(s, path))?.pending?.text).toBe("mine");
  });
  it("restarts a queue left syncing when the application closed", async () => {
    const s = scope(), t = transport();
    await queueDocument(s, path, edit("mine"), base);
    await updateLocal(s, path, (row) => ({ ...row!, status: "syncing" }));
    await syncLocal(s, t);
    expect((await readLocal(s, path))?.pending).toBeNull();
  });
});

it("restores Undo metadata in the local document and forwards it through the normal save", async () => {
  const s = scope(), t = transport();
  const restore = { fetchedAt: 42, title: "Song", artist: "Artist", lineConfidence: [0.8], lowLines: [0], result: { timingSource: "aligned:mms-fa" } };
  await queueDocument(s, path, { ...edit(base.text), restore }, base);
  expect((await readLocal(s, path))?.doc).toMatchObject(restore);
  // A different body ensures the transport actually performs the write.
  t.get = async () => ({ ...base, text: "Replacement" });
  await syncLocal(s, t);
  expect(t.put).toHaveBeenCalledWith(path, expect.objectContaining({ restore }));
});

it("durably queues tag-only nudges, coalesces them and replays through the offset route", async () => {
  const s = scope(), t = transport();
  t.offset = vi.fn(async (_path, offsetMs) => ({ ...base, text: `[offset:${offsetMs > 0 ? "+" : ""}${offsetMs}]\n${base.text}`, offsetMs, revision: "r2" }));
  await queueOffset(s, path, 100, base);
  await queueOffset(s, path, 600, base);
  expect((await readLocal(s, path))?.doc).toMatchObject({ fetchedAt: 1, edited: true, offsetMs: 600 });
  vi.mocked(t.offset).mockRejectedValueOnce(new Error("offline"));
  await syncLocal(s, t);
  expect((await readLocal(s, path))?.pending?.offsetMs).toBe(600);
  await syncLocal(s, t);
  expect(t.offset).toHaveBeenLastCalledWith(path, 600, "r1");
  expect(t.put).not.toHaveBeenCalled();
  expect(await readLocal(s, path)).toMatchObject({ pending: null, revision: "r2", status: "synced" });
});

it("folds an offset into an unsynced lyric replacement without shifting its stamps", async () => {
  const s = scope(), t = transport();
  await queueDocument(s, path, edit("[00:02.00]New"), base);
  await queueOffset(s, path, -100, base);
  await syncLocal(s, t);
  expect(t.put).toHaveBeenCalledWith(path, expect.objectContaining({ text: "[offset:-100]\n[00:02.00]New" }));
});

it("migrates queued edits and preserves newer destination edits and legacy recovery rows", async () => {
  const { migrateLocalScopes } = await import('./localLyrics');
  const old = scope(), current = scope();
  await queueDocument(old, path, edit('old pending'), base);
  await migrateLocalScopes(current, [old]);
  expect(await readLocal(current, path)).toMatchObject({ pending: { text: 'old pending' }, revision: 'r1', status: 'local' });
  await queueDocument(current, path, edit('new pending'), base);
  await migrateLocalScopes(current, [old]);
  expect((await readLocal(current, path))?.pending?.text).toBe('new pending');
  expect((await readLocal(old, path))?.pending?.text).toBe('old pending');
});
