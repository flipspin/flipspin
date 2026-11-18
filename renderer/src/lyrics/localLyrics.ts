import { readLyricsOffset as readOffset, setLyricsOffset } from "./lrc";
import type { LyricsDoc, SavePayload } from "./lyricsStore";

export type LocalStatus = "synced" | "local" | "syncing" | "conflict" | "blocked";
export interface LyricsValidation {
  etag?: string;
  checkedAt?: number;
  indexRevision?: string;
  jobsRevision?: string;
}
export interface LocalLyric {
  scope: string;
  path: string;
  doc: LyricsDoc | null;
  revision: string | null;
  pending: (SavePayload & { offsetMs?: number }) | null;
  version: number;
  status: LocalStatus;
  /** Completed the background pass for an offline pin, including a 404. */
  offlineCached?: boolean;
  validation?: LyricsValidation;
}

let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("krobi-lyrics", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("lyrics", { keyPath: ["scope", "path"] });
      store.createIndex("scope", "scope");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => { database = undefined; throw error; });
  return database;
}

/** Read/modify/write in one transaction so renderer windows cannot drop edits. */
export async function updateLocal(scope: string, path: string, change: (row: LocalLyric | undefined) => LocalLyric | undefined): Promise<LocalLyric | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("lyrics", "readwrite");
    const store = tx.objectStore("lyrics");
    const get = store.get([scope, path]);
    let result: LocalLyric | undefined;
    get.onsuccess = () => {
      try {
        result = change(get.result);
        if (result) store.put(result);
        else store.delete([scope, path]);
      } catch (error) { tx.abort(); reject(error); }
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Local lyrics transaction aborted"));
  });
}
export async function readLocal(scope: string, path: string): Promise<LocalLyric | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction("lyrics").objectStore("lyrics").get([scope, path]);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function listLocal(scope: string): Promise<LocalLyric[]> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const request = database.transaction("lyrics").objectStore("lyrics").index("scope").getAll(scope);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Copy only known aliases of this backend/account, in one cross-window transaction.
 * Keep legacy rows as a recovery copy; an existing destination always wins. */
export async function migrateLocalScopes(scope: string, aliases: string[]): Promise<void> {
  const database = await db();
  await new Promise<void>((resolve, reject) => {
    const tx = database.transaction("lyrics", "readwrite");
    const store = tx.objectStore("lyrics");
    const sources = [...new Set(aliases.filter(alias => alias !== scope))];
    // Process aliases in order so the validated instance precedes the old
    // transport fallback when both contain the same path.
    function next(index: number) {
      if (index === sources.length) return;
      const request = store.index("scope").getAll(sources[index]);
      request.onsuccess = () => {
        const rows = request.result as LocalLyric[];
        if (!rows.length) { next(index + 1); return; }
        let remaining = rows.length;
        for (const row of rows) {
          const existing = store.get([scope, row.path]);
          existing.onsuccess = () => {
            if (!existing.result) store.put({ ...row, scope });
            if (--remaining === 0) next(index + 1);
          };
        }
      };
    }
    next(0);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function cacheDocument(scope: string, path: string, doc: LyricsDoc | null, offlineCached = false, validation?: LyricsValidation) {
  return updateLocal(scope, path, (row) => row?.pending ? row : {
    scope, path, doc, revision: doc ? doc.revision ?? null : "", pending: null,
    version: (row?.version ?? 0) + 1, status: "synced",
    offlineCached: offlineCached || row?.offlineCached || false,
    validation,
  });
}

export function queueDocument(scope: string, path: string, payload: SavePayload, base: LyricsDoc | null) {
  return updateLocal(scope, path, (row) => {
    const previous = row?.doc ?? base;
    const doc = {
      ...previous, ...payload.restore, relPath: path, fetchedAt: payload.restore?.fetchedAt ?? previous?.fetchedAt ?? 0,
      kind: payload.kind, text: payload.text, offsetMs: readOffset(payload.text), source: payload.source,
      providerRef: payload.providerRef ?? null, edited: payload.edited ?? false,
      lowLines: payload.kind === "synced" ? payload.restore?.lowLines ?? null : null,
      lineConfidence: payload.kind === "synced" ? payload.restore?.lineConfidence ?? null : null,
      result: payload.restore?.result ?? null,
    };
    return {
      scope, path, doc, pending: payload,
      revision: row ? row.revision : base ? base.revision ?? null : "",
      version: (row?.version ?? 0) + 1,
      status: row?.status === "conflict" ? "conflict" : "local",
    };
  });
}

/** Merge into a pending full save, or queue a tag-only write against the baseline. */
export function queueOffset(scope: string, path: string, offsetMs: number, base: LyricsDoc) {
  return updateLocal(scope, path, row => {
    const previous = row?.doc ?? base;
    const text = setLyricsOffset(previous.text, offsetMs);
    const pending = row?.pending && row.pending.offsetMs === undefined
      ? { ...row.pending, text }
      : { kind: previous.kind, text, source: previous.source, edited: previous.edited,
          providerRef: previous.providerRef, offsetMs };
    return { scope, path, doc: { ...previous, text, offsetMs }, pending,
      revision: row ? row.revision : base.revision ?? null, version: (row?.version ?? 0) + 1,
      status: row?.status === "conflict" ? "conflict" : "local" };
  });
}

export interface SyncTransport {
  get: (path: string) => Promise<LyricsDoc | null>;
  put: (path: string, payload: SavePayload) => Promise<LyricsDoc>;
  offset: (path: string, offsetMs: number, revision: string) => Promise<LyricsDoc>;
  changed: (row: LocalLyric) => void;
  active: () => boolean;
  conflict: (error: unknown) => boolean;
  blocked: (error: unknown) => boolean;
}

/** One pass; unresolved network failures stay durable for the next retry. */
export async function syncLocal(scope: string, transport: SyncTransport) {
  for (const snapshot of await listLocal(scope)) {
    if (!transport.active()) return;
    if (!snapshot.pending || snapshot.status === "conflict" || snapshot.status === "blocked") continue;
    const publish = async (change: (row: LocalLyric) => LocalLyric) => {
      const row = await updateLocal(scope, snapshot.path, (row) => row ? change(row) : row);
      if (row && transport.active()) transport.changed(row);
    };
    await publish((row) => ({ ...row, status: "syncing" }));
    try {
      const remote = await transport.get(snapshot.path);
      if (!transport.active()) return;
      // The GET may outlive an edit or an explicit discard in another window.
      // Never upload the snapshot after the durable queue has moved on.
      const current = await readLocal(scope, snapshot.path);
      if (!transport.active()) return;
      if (!current?.pending || current.version !== snapshot.version || current.revision !== snapshot.revision) continue;
      const desired = snapshot.pending;
      // A lost PUT response is safe to replay: recognise the acknowledged content.
      const alreadySaved = remote && remote.text.replace(/\r\n?/g, "\n").replace(/\n+$/, "") === desired.text.replace(/\r\n?/g, "\n").replace(/\n+$/, "") && remote.kind === desired.kind
        && remote.source === desired.source && remote.edited === (desired.edited ?? false)
        && (remote.providerRef ?? null) === (desired.providerRef ?? null);
      if (!alreadySaved && (snapshot.revision === null || (remote && !remote.revision))) {
        await publish((row) => ({ ...row, status: "blocked" }));
        continue;
      }
      if (!alreadySaved && (remote?.revision ?? "") !== snapshot.revision) {
        await publish((row) => ({ ...row, status: "conflict" }));
        continue;
      }
      const saved = alreadySaved ? remote : desired.offsetMs !== undefined
        ? await transport.offset(snapshot.path, desired.offsetMs, snapshot.revision!)
        : await transport.put(snapshot.path, { ...desired, expectedRevision: snapshot.revision! });
      await publish((row) => !row.pending ? row : row.version === snapshot.version
        ? { ...row, doc: saved, revision: saved.revision ?? null, pending: null, status: "synced" }
        : { ...row, revision: saved.revision ?? null, status: "local" });
    } catch (error) {
      if (!transport.active()) return;
      await publish((row) => !row.pending ? row : ({ ...row, status: transport.conflict(error) ? "conflict" : transport.blocked(error) ? "blocked" : "local" }));
    }
  }
}
