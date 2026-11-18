import { poll } from '../data/poll'
import { watchChanges } from '../data/changeListeners'
/** Keep lyrics state and the availability cache outside React so the overlay survives navigation
 * and shares job updates with the sidebar and dialogs. */
import { useEffect, useSyncExternalStore } from "react";

import { apiDelete, apiGet, apiPost, apiPut, ApiError, getApiClient, isNotFound, isApiError, optionalBridge } from "../data";
import i18n from "../i18n";
import { isOfflineNow } from "../offline/policy";
import { offlineLyricStates } from "./lyricStates";
import { watchOfflineLyrics } from "../offline/lyricsCache";
import { cacheDocument, migrateLocalScopes, listLocal, queueDocument, queueOffset, readLocal, syncLocal, updateLocal, type LocalLyric, type LocalStatus, type LyricsValidation } from "./localLyrics";
import type { ApiData } from "../data";
import { getLibraryRoot, keysForPath } from "../library/libraryKeys";

export type LyricsDoc = ApiData<"/api/lyrics/{album}/{file}", "get">;
export type LyricsCandidate = ApiData<"/api/lyrics/search", "post">["candidates"][number];
export type LyricsSearch = ApiData<"/api/lyrics/search", "post">;
export type LyricsJobs = {
  oldestPendingAt?: number | null;
  autoFetch: boolean;
  providers: string[];
  running: {
    progressId: string;
    label: string;
    done: number;
    total: number;
    found: number;
    pending: number;
    item: string | null;
  } | null;
  queued: number;
  withLyrics: number;
  pendingCount: number;
  pending: { relPath: string; title: string; artist: string; album: string; triedAt: number; reason: string }[];
  lastRun: { progressId: string; total: number; found: number; pending: number; skipped: number; errors: number } | null;
  engine?: LyricsEngine;
};

/** `/api/lyrics/engine`; the Mac worker's state, with a hint code for why not. */
export type LyricsEngine = {
  engineReady?: boolean;
  sizeBytes?: number | null;
  addons?: Record<'lyrics' | 'stems', import('../lib/ipc').AddonStatus> & Partial<Record<'analysis' | 'gpu', import('../lib/ipc').AddonStatus>>;
  helpers?: import("../api/generated/schema").SchemaLyricsEngineResponse['helpers'];
  waitReason?: import("../api/generated/schema").SchemaLyricsEngineResponse['waitReason'];
  oldestAt?: number | null;
  waiting?: { count: number; oldestAt: number | null } | null;
  worker?: import("../api/generated/schema").SchemaMacWorker | null;
  supported: boolean;
  installed: boolean;
  ready: boolean;
  hint: "ready" | "not-installed" | "no-python" | "no-uv" | "installing" | "install-failed" | "unsupported-platform" | "broken" | "models-missing" | "agent-needed" | "agent-online";
  /** `local`; the backend runs the engine; `agent`; a Mac drains the server's queue. */
  mode: "local" | "agent";
  queue: { oldestQueuedAt?: number | null; queued: number; leased: number; online: boolean; agents: { name: string; platform: string; version: string; lastSeenAt: number; busy: boolean }[] };
  installError: string | null;
  checkError?: string | null;
  installing: { target?: string; progressId: string; phase: string | null; percent: number | null } | null;
  running: { progressId: string; total: number; done: number; saved: number; failed: number } | null;
  version: string | null;
  python: string | null;
  models: Record<string, boolean> | null;
  uv: boolean;
  toolsDir: string;
  modelsDir: string;
};

/** `GET /api/download-progress/{id}`; the shared tracker's snapshot of one job. */
export type JobProgress = {
  progress_id: string;
  total: number;
  completed: number;
  percentage: number;
  status: string;
  terminal: boolean;
  succeeded: number | null;
  failed: number | null;
  failures?: { reason?: string }[];
  items: string[];
  active: Record<string, { phase: string; percent: number | null }>;
};

/** `"<albumDir>/<fileName>"` split the way the routes want it. */
export function splitRelPath(relPath: string): { album: string; file: string } {
  const slash = relPath.indexOf("/");
  return { album: relPath.slice(0, slash), file: relPath.slice(slash + 1) };
}

/** Keep the last-two-segments fallback before the server root or account is available.
 * An unsupported deeper key safely returns 404 rather than opening another lyric. */
export function lyricsKeyOf(track: { path?: string | null; relPath?: string | null } | null | undefined): string | null {
  if (track?.relPath) return track.relPath;
  const raw = track?.path;
  if (!raw) return null;
  const keys = keysForPath(raw, getLibraryRoot());
  if (keys) return `${keys.album}/${keys.file}`;
  const parts = String(raw).replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

interface State {
  /** relPath → document, or null when the server said 404. */
  docs: Record<string, LyricsDoc | null>;
  /** The song the overlay is showing, or null when closed. */
  overlayRelPath: string | null;
  /** The song the "Lyrics…" modal is open for, or null. */
  modalRelPath: string | null;
  modalMode?: "search" | "own";
  jobs: LyricsJobs | null;
  jobsError: string | null;
  jobsFailure?: unknown;
  reviewLine?: number | null;
}

let state: State = { docs: {}, overlayRelPath: null, modalRelPath: null, jobs: null, jobsError: null };
const listeners = new Set<() => void>();

function emit(next: Partial<State>) {
  state = { ...state, ...next };
  listeners.forEach((fn) => fn());
}

export function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getState() {
  return state;
}

// ------------------------------------------------------------------ docs

const inflight = new Map<string, Promise<LyricsDoc | null>>();
const validations = new Map<string, LyricsValidation>();
const attempts = new Map<string, LyricsValidation & { at: number; failed?: boolean }>();
const REVALIDATE_MS = 10 * 60 * 1000;
const NONE_MS = 6 * 60 * 60 * 1000;
let indexRevision: string | undefined;
let jobsRevision: string | undefined;

async function requestLyrics(relPath: string, signal?: AbortSignal, etag?: string) {
  if (isOfflineNow()) throw new Error(i18n.t("Lyrics are unavailable offline"));
  const { album, file } = splitRelPath(relPath);
  const client = await getApiClient();
  if (isOfflineNow()) throw new Error(i18n.t("Lyrics are unavailable offline"));
  const { data, error, response } = await client.GET("/api/lyrics/{album}/{file}", {
    params: { path: { album, file } }, signal, fetch: optionalBridge()?.fetch, headers: etag ? { "If-None-Match": etag } : {},
  });
  if (response.status !== 304 && response.status !== 404 && !response.ok) {
    throw new ApiError({ kind: "http", status: response.status, method: "GET", path: "/api/lyrics/{album}/{file}", body: error, message: `Lyrics: ${response.status}` });
  }
  return { doc: data ?? null, current: response.status === 304, etag: response.headers.get("ETag") ?? undefined };
}

async function fetchLyrics(relPath: string, signal?: AbortSignal): Promise<LyricsDoc | null> {
  return (await requestLyrics(relPath, signal)).doc;
}

function revisionChanged(validation?: LyricsValidation) {
  return (indexRevision !== undefined && validation?.indexRevision !== indexRevision)
    || (jobsRevision !== undefined && validation?.jobsRevision !== jobsRevision);
}

/** Called by the existing index poll; completed jobs also refresh positive copies. */
export function lyricsIndexChanged(revision: string, completed: string[] = []) {
  const changed = indexRevision !== revision;
  indexRevision = revision;
  if (changed) refreshKnownAbsences();
  for (const path of completed) if (path in state.docs) void loadLyrics(path, { force: true }).catch(() => {});
}

function refreshKnownAbsences() {
  for (const [path, doc] of Object.entries(state.docs)) {
    if (doc === null) void loadLyrics(path).catch(() => {});
  }
}

/** Cached text opens immediately; server refreshes never replace queued edits. */
export function loadLyrics(relPath: string, { force = false, waitForRefresh = false, signal }: { force?: boolean; waitForRefresh?: boolean; signal?: AbortSignal } = {}): Promise<LyricsDoc | null> {
  watchLyricsIdentity();
  const offline = isOfflineNow();
  const pending = offline ? undefined : inflight.get(relPath);
  if (pending) return !force && !waitForRefresh && relPath in state.docs ? Promise.resolve(state.docs[relPath]) : pending;
  const generation = localGeneration;
  const request = (async () => {
    const scope = await (localState.enabled ? initializeLocalLyrics() : Promise.resolve(null));
    const cached = scope ? await readLocal(scope, relPath) : undefined;
    if (generation !== localGeneration) return null;
    if (cached && scope === localScope) {
      if (cached.pending || !(relPath in state.docs) || Boolean(state.docs[relPath]) !== Boolean(cached.doc)
        || state.docs[relPath]?.revision !== cached.doc?.revision) publishLocal(cached);
      if (cached.pending) return cached.doc;
    }
    const known = relPath in state.docs;
    const doc = known ? state.docs[relPath] : null;
    const validation = cached?.validation ?? validations.get(relPath);
    const attempt = attempts.get(relPath);
    const invalidated = doc === null && revisionChanged(validation) && (!attempt || revisionChanged(attempt));
    const now = Date.now();
    const checkedAt = validation?.checkedAt;
    const attemptedAt = attempt?.at ?? checkedAt;
    const fresh = checkedAt !== undefined && now - checkedAt < (doc === null ? NONE_MS : REVALIDATE_MS)
      && !(doc === null && revisionChanged(validation));
    const throttled = attemptedAt !== undefined && now - attemptedAt < REVALIDATE_MS;
    if (isOfflineNow() || (!force && known && !invalidated && (fresh || throttled))) return doc;
    const refreshing = refresh().finally(() => {
      if (inflight.get(relPath) !== refreshing) return;
      inflight.delete(relPath);
      // An index poll can finish while the conditional GET is still in flight.
      if (generation === localGeneration && state.docs[relPath] === null && revisionChanged(validations.get(relPath)) && !isOfflineNow()) {
        void loadLyrics(relPath).catch(() => {});
      }
    });
    inflight.set(relPath, refreshing);
    if (known && !force && !waitForRefresh) { void refreshing.catch(() => {}); return doc; }
    return refreshing;
    async function refresh() {
      const revisions = { indexRevision, jobsRevision };
      attempts.set(relPath, { at: now, ...revisions });
      const result = await requestLyrics(relPath, signal ? AbortSignal.any([signal, localController.signal]) : localController.signal, doc?.revision ? `"${doc.revision}"` : validation?.etag).catch(error => {
        if (generation === localGeneration) attempts.set(relPath, { at: now, ...revisions, failed: true });
        throw error;
      });
      if (generation !== localGeneration || (scope && scope !== localScope) || isOfflineNow()) return doc;
      const nextValidation = { etag: result.etag ?? (result.current ? validation?.etag : undefined), checkedAt: Date.now(), ...revisions };
      if (result.current) {
        // Update only validation metadata. Keep the document and its subscribers untouched.
        if (scope) await updateLocal(scope, relPath, row => row && !row.pending ? { ...row, validation: nextValidation } : row);
        if (generation !== localGeneration || (scope && scope !== localScope)) return doc;
        validations.set(relPath, nextValidation);
        return doc;
      }
      const row = scope ? await cacheDocument(scope, relPath, result.doc, false, nextValidation) : undefined;
      if (generation !== localGeneration || (scope && scope !== localScope)) return doc;
      if (!row?.pending) validations.set(relPath, nextValidation);
      const next = row ? row.doc : result.doc;
      emit({ docs: { ...state.docs, [relPath]: next } });
      return next;
    }
  })().finally(() => { if (inflight.get(relPath) === request) inflight.delete(relPath); });
  inflight.set(relPath, request);
  return request;
}

export async function alignLyrics(relPath: string, payload: SavePayload): Promise<{ progressId: string; total: number }> {
  if (localState.enabled) {
    const scope = await initializeLocalLyrics();
    await drainLocal();
    if (scope && (await readLocal(scope, relPath))?.pending) {
      throw new Error(i18n.t("Sync local changes before aligning lyrics"));
    }
  }
  const result = await apiPost("/api/lyrics/align", { body: { ...splitRelPath(relPath), ...payload, edited: payload.edited ?? false, force: payload.force ?? false } });
  void refreshJobs().then(schedule);
  return result;
}

export interface LyricsSearchOptions { source?: string; plainOnly?: boolean }
export interface LyricsSource { id: string; name: string; enabled: boolean; available: boolean; unavailableReason?: string | null; capabilities: string[] }
export async function loadLyricsSources(): Promise<LyricsSource[]> {
  const result = await apiGet("/api/providers") as { providers: (LyricsSource & { kind: string })[] };
  return result.providers.filter((provider) => provider.kind === "lyrics");
}

export function searchLyrics(relPath: string, options: LyricsSearchOptions = {}): Promise<LyricsSearch> {
  const { album, file } = splitRelPath(relPath);
  return apiPost("/api/lyrics/search", { body: { album, file, plainOnly: options.plainOnly ?? false, ...options } });
}

export interface SavePayload {
  restore?: Pick<LyricsDoc, "fetchedAt" | "title" | "artist" | "lineConfidence" | "lowLines" | "result">;
  kind: string;
  text: string;
  source: string;
  providerRef?: string | null;
  edited?: boolean;
  force?: boolean;
  expectedRevision?: string;
}

async function putLyrics(relPath: string, payload: SavePayload, signal?: AbortSignal): Promise<LyricsDoc> {
  const { album, file } = splitRelPath(relPath);
  const doc = await apiPut("/api/lyrics/{album}/{file}", {
    signal,
    params: { path: { album, file } },
    body: {
      ...(payload.restore ? { restore: payload.restore } : {}),
      kind: payload.kind,
      text: payload.text,
      source: payload.source,
      providerRef: payload.providerRef ?? null,
      edited: payload.edited ?? false,
      force: payload.force ?? false,
      expectedRevision: payload.expectedRevision ?? null,
    },
  });
  return doc;
}

/** Local commits finish only after IndexedDB commits; quota errors are not success. */
export async function saveLyrics(relPath: string, payload: SavePayload): Promise<LyricsDoc> {
  if (localState.enabled) {
    const scope = await initializeLocalLyrics();
    if (!scope) throw new Error(i18n.t("Could not open local lyrics storage"));
    // A new lyric needs a known baseline, otherwise an offline replacement is unsafe.
    const base = relPath in state.docs ? state.docs[relPath] : await loadLyrics(relPath);
    if (scope !== localScope || !localState.enabled) throw new Error(i18n.t("The account changed; reopen the lyrics"));
    const row = await queueDocument(scope, relPath, payload, base);
    if (!row?.doc) throw new Error(i18n.t("Could not save lyrics on this device"));
    publishLocal(row);
    broadcast?.postMessage(scope);
    scheduleLocalSync(900);
    return row.doc;
  }
  const doc = await putLyrics(relPath, payload);
  emit({ docs: { ...state.docs, [relPath]: doc } });
  void refreshJobs();
  return doc;
}

async function putOffset(relPath: string, offsetMs: number, expectedRevision?: string | null, signal?: AbortSignal): Promise<LyricsDoc> {
  return apiPut("/api/lyrics/{album}/{file}/offset", {
    params: { path: splitRelPath(relPath) }, body: { offsetMs, expectedRevision }, signal,
    // Flushes on pagehide must be allowed to finish after the view unloads.
    keepalive: true,
  });
}

export async function saveLyricsOffset(relPath: string, offsetMs: number, base: LyricsDoc): Promise<LyricsDoc> {
  if (localState.enabled) {
    const scope = await initializeLocalLyrics();
    if (!scope) throw new Error(i18n.t("Could not open local lyrics storage"));
    const row = await queueOffset(scope, relPath, offsetMs, base);
    if (!row?.doc || scope !== localScope) throw new Error(i18n.t("The account changed; reopen the lyrics"));
    publishLocal(row);
    broadcast?.postMessage(scope);
    scheduleLocalSync(900);
    return row.doc;
  }
  const doc = await putOffset(relPath, offsetMs, base.revision);
  emit({ docs: { ...state.docs, [relPath]: doc } });
  return doc;
}

export async function deleteLyrics(relPath: string, expectedRevision?: string): Promise<void> {
  const scope = localState.enabled ? await initializeLocalLyrics() : null;
  if (scope && (await readLocal(scope, relPath))?.pending) throw new Error(i18n.t("Sync or discard local changes before removing lyrics"));
  const { album, file } = splitRelPath(relPath);
  await apiDelete("/api/lyrics/{album}/{file}", { params: { path: { album, file }, ...(expectedRevision !== undefined ? { query: { expectedRevision } } : {}) } });
  if (scope) await cacheDocument(scope, relPath, null);
  emit({ docs: { ...state.docs, [relPath]: null } });
  void refreshJobs();
}

// ----------------------------------------------------------- local cache
const LOCAL_KEY = "krobi.localLyrics";
function readLocalPreference() { try { return localStorage.getItem(LOCAL_KEY) === "1"; } catch { return false; } }
let localState = { enabled: readLocalPreference(), rows: [] as LocalLyric[], error: "" };
let localScope: string | null = null;
let localInit: Promise<string | null> | null = null;
let localTimer: ReturnType<typeof setTimeout> | undefined;
let localRun: Promise<void> | null = null;
let localGeneration = 0;
let localController = new AbortController();
let stopOfflineLyrics: (() => void) | undefined;
let removeIdentityListener: (() => void) | undefined;
let broadcast: BroadcastChannel | undefined;
const localListeners = new Set<() => void>();
function emitLocal() { localListeners.forEach((fn) => fn()); }
function publishLocal(row: LocalLyric) {
  if (row.scope !== localScope) return;
  localState = { ...localState, rows: [...localState.rows.filter((r) => r.path !== row.path), row] };
  emit({ docs: { ...state.docs, [row.path]: row.doc } });
  emitLocal();
}
function watchLyricsIdentity() {
  removeIdentityListener ??= optionalBridge()?.on("auth:changed", () => {
    stopOfflineLyrics?.(); stopOfflineLyrics = undefined;
    localGeneration++;
    localController.abort(); localController = new AbortController();
    localScope = null; localInit = null;
    clearTimeout(localTimer);
    localState = { ...localState, rows: [], error: "" };
    validations.clear(); attempts.clear(); inflight.clear(); indexRevision = undefined; jobsRevision = undefined;
    emit({ docs: {}, overlayRelPath: null, modalRelPath: null, jobs: null }); emitLocal();
    void initializeLocalLyrics();
  });
}
export function initializeLocalLyrics(): Promise<string | null> {
  watchLyricsIdentity();
  if (!localState.enabled) return Promise.resolve(null);
  if (localInit) return localInit;
  const generation = localGeneration;
  localInit = (async () => {
    try {
      const bridge = optionalBridge();
      if (!bridge) throw new Error(i18n.t("Could not identify this device"));
      const [origin, identity] = await Promise.all([
        bridge.invoke("app:get-backend-origin", undefined),
        bridge.invoke("auth:get", undefined),
      ]);
      if (generation !== localGeneration) return null;
      if (!origin.backendKey) throw new Error(i18n.t("Could not identify this device"));
      const account = identity.userId || identity.label || (identity.hasToken ? "legacy" : "local");
      const scope = JSON.stringify([origin.backendKey, account]);
      await migrateLocalScopes(scope, [origin.instanceId, origin.origin].filter((key): key is string => Boolean(key)).map(key => JSON.stringify([key, account])));
      const rows = await listLocal(scope);
      if (generation !== localGeneration) return null;
      localScope = scope;
      localState = { ...localState, rows, error: "" }; emitLocal();
      if (typeof BroadcastChannel !== "undefined" && !broadcast) {
        broadcast = new BroadcastChannel("krobi-lyrics");
        broadcast.onmessage = () => { void reloadLocal().then(() => scheduleLocalSync(900)).catch(localError); };
      }
      window.addEventListener("online", retryLocalLyrics);
      scheduleLocalSync(900);
      stopOfflineLyrics?.();
      stopOfflineLyrics = watchOfflineLyrics(async (path, signal) => {
        if (generation !== localGeneration || !localState.enabled || scope !== localScope) return;
        const cached = await readLocal(scope, path);
        if (cached?.pending || cached?.offlineCached) return;
        // Pins share the foreground throttle and in-flight request, including 404s.
        await loadLyrics(path, { force: attempts.get(path)?.failed, waitForRefresh: true, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
        if (generation !== localGeneration || !localState.enabled || scope !== localScope || isOfflineNow()) return;
        await updateLocal(scope, path, row => row ? { ...row, offlineCached: true } : row);
      }, async (keys, signal) => {
        if (!keys.length) return [];
        const states = await offlineLyricStates(signal);
        return keys.filter(path => states[path] === "synced" || states[path] === "plain");
      });
      return scope;
    } catch (error) { localInit = null; localError(error); return null; }
  })();
  return localInit;
}
function localError(error: unknown) {
  localState = { ...localState, error: error instanceof Error ? error.message : String(error) }; emitLocal();
}
async function reloadLocal() {
  const scope = localScope;
  if (!scope) return;
  const rows = await listLocal(scope);
  if (scope !== localScope) return;
  localState = { ...localState, rows }; emitLocal();
  for (const row of rows) if (row.path in state.docs) emit({ docs: { ...state.docs, [row.path]: row.doc } });
}
function scheduleLocalSync(delay = 15000) {
  clearTimeout(localTimer);
  if (localState.enabled && localState.rows.some((row) => row.pending && (row.status === "local" || row.status === "syncing"))) localTimer = setTimeout(() => void drainLocal(), delay);
}
function drainLocal(): Promise<void> {
  localRun ??= performLocalSync().finally(() => { localRun = null; });
  return localRun;
}
async function performLocalSync() {
  if (!localScope || !localState.enabled || isOfflineNow()) return;
  const scope = localScope;
  const generation = localGeneration;
  const active = () => scope === localScope && generation === localGeneration && localState.enabled && !isOfflineNow();
  const run = () => syncLocal(scope, {
    active,
    get: (path) => fetchLyrics(path, AbortSignal.any([localController.signal, AbortSignal.timeout(15000)])),
    put: (path, payload) => putLyrics(path, payload, AbortSignal.any([localController.signal, AbortSignal.timeout(15000)])),
    offset: (path, offsetMs, revision) => putOffset(path, offsetMs, revision, AbortSignal.any([localController.signal, AbortSignal.timeout(15000)])),
    changed: publishLocal,
    conflict: (e) => isApiError(e) && e.status === 409,
    blocked: (e) => isApiError(e) && Boolean(e.status && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429),
  });
  try {
    if (navigator.locks) await navigator.locks.request(`lyrics:${scope}`, async () => { if (active()) await run(); });
    else await run(); // Server revision checks still protect older WebViews.
    if (active()) { await reloadLocal(); broadcast?.postMessage(scope); }
  } catch (error) { localError(error); }
  finally { if (localState.rows.some((r) => r.pending && r.status === "local")) scheduleLocalSync(); }
}
export function retryLocalLyrics() {
  void (async () => {
    const scope = await initializeLocalLyrics();
    if (!scope) return;
    for (const row of await listLocal(scope)) if (row.status === "blocked") {
      await updateLocal(scope, row.path, (current) => current ? { ...current, status: "local" } : current);
    }
    await reloadLocal();
    scheduleLocalSync(0);
  })().catch(localError);
}
export async function setLocalLyricsEnabled(enabled: boolean) {
  const scope = !enabled && localState.enabled ? await initializeLocalLyrics() : null;
  if (!enabled && scope && (await listLocal(scope)).some((row) => row.pending)) {
    throw new Error(i18n.t("Sync or discard local changes before turning this option off"));
  }
  if (enabled && typeof indexedDB === "undefined") throw new Error(i18n.t("Local storage is unavailable"));
  localStorage.setItem(LOCAL_KEY, enabled ? "1" : "0");
  localState = { ...localState, enabled, error: "" }; emitLocal();
  if (enabled) await initializeLocalLyrics();
  else { localGeneration++; localController.abort(); localController = new AbortController(); stopOfflineLyrics?.(); stopOfflineLyrics = undefined; clearTimeout(localTimer); localInit = null; localScope = null; }
}
/** Explicit conflict resolution: compare-and-swap still applies to 'keep mine'. */
export async function resolveLocalLyrics(path: string, keepLocal: boolean) {
  const scope = await initializeLocalLyrics();
  if (!scope) return;
  // Finish any already-issued PUT before resolving, including other windows.
  // Otherwise 'use server' can read the old document just before that PUT lands.
  await localRun;
  const resolve = () => resolveLocalLyricsInScope(scope, path, keepLocal);
  if (navigator.locks) await navigator.locks.request(`lyrics:${scope}`, resolve);
  else await resolve();
}
async function resolveLocalLyricsInScope(scope: string, path: string, keepLocal: boolean) {
  if (scope !== localScope) return;
  const before = await readLocal(scope, path);
  const remote = await fetchLyrics(path);
  if (scope !== localScope) return;
  const row = await updateLocal(scope, path, (current) => {
    if (!current || current.version !== before?.version) throw new Error(i18n.t("The lyrics changed; review them again"));
    return keepLocal ? { ...current, revision: remote ? remote.revision ?? null : "", status: "local", version: current.version + 1 }
      : { ...current, doc: remote, pending: null, revision: remote ? remote.revision ?? null : "", status: "synced", version: current.version + 1 };
  });
  if (row) publishLocal(row);
  broadcast?.postMessage(scope);
  scheduleLocalSync(0);
}
export function useLocalLyrics() {
  useEffect(() => { void initializeLocalLyrics(); }, []);
  return useSyncExternalStore((fn) => { localListeners.add(fn); return () => { localListeners.delete(fn); }; }, () => localState);
}
export function useLocalLyricsEnabled() {
  return useSyncExternalStore((fn) => { localListeners.add(fn); return () => { localListeners.delete(fn); }; }, () => localState.enabled);
}
export function useLocalLyricsStatus(path: string): LocalStatus | null {
  const read = () => localState.rows.find((row) => row.path === path && row.pending)?.status ?? null;
  return useSyncExternalStore((fn) => { localListeners.add(fn); return () => { localListeners.delete(fn); }; }, read);
}

// --------------------------------------------------------------- overlay

export function openLyrics(relPath: string, reviewLine: number | null = null) {
  emit({ overlayRelPath: relPath, reviewLine });
  void loadLyrics(relPath).catch(() => {});
}

export function closeLyrics() {
  emit({ overlayRelPath: null });
}

export function openLyricsModal(relPath: string, mode: "search" | "own" = "search") {
  emit({ modalRelPath: relPath, modalMode: mode });
}

export function closeLyricsModal() {
  emit({ modalRelPath: null });
}

/** The lyrics affordance always opens the view, including its empty state. */
export async function openLyricsOrAdd(relPath: string) {
  openLyrics(relPath);
}

// ------------------------------------------------------------------ jobs

let stopJobsPoll: (() => void) | undefined;
let jobsWatchers = 0;

export async function refreshJobs(): Promise<LyricsJobs | null> {
  if (isOfflineNow() || poll('idle') === false) return state.jobs;
  watchLyricsIdentity();
  const generation = localGeneration;
  try {
    const jobs = (await apiGet("/api/lyrics/jobs")) as LyricsJobs;
    if (generation !== localGeneration || isOfflineNow()) return null;
    // Stable result fields only: unrelated engine heartbeats must not expire negatives.
    const revision = JSON.stringify([jobs.withLyrics, jobs.pendingCount, jobs.lastRun, jobs.running?.done, jobs.engine?.running?.done]);
    const changed = jobsRevision !== revision;
    jobsRevision = revision;
    emit({ jobs, jobsError: null, jobsFailure: null });
    if (changed) refreshKnownAbsences();
    return jobs;
  } catch (error) {
    if (generation !== localGeneration) return null;
    emit({ jobsError: error instanceof Error ? error.message : String(error), jobsFailure: error });
    return null;
  }
}

function schedule() {
  if (jobsWatchers) { stopJobsPoll?.(); stopJobsPoll = watchChanges(['jobs', 'lyrics', 'helpers'], refreshJobs, false); }
}
export function watchJobs(): () => void {
  jobsWatchers++;
  if (jobsWatchers === 1) stopJobsPoll = watchChanges(['jobs', 'lyrics', 'helpers'], refreshJobs);
  return () => {
    jobsWatchers = Math.max(0, jobsWatchers - 1);
    if (!jobsWatchers) { stopJobsPoll?.(); stopJobsPoll = undefined; }
  };
}

export type PendingSong = LyricsJobs["pending"][number];

/**
 * Every song the catalogs lacked, newest first. `/jobs` names only a preview;
 * a server older than `/pending` answers 404, and then the preview is all
 * there is; `complete: false` says so.
 */
export async function fetchPendingSongs(): Promise<{ songs: PendingSong[]; total: number; complete: boolean }> {
  try {
    const body = await apiGet("/api/lyrics/pending");
    return { songs: body.pending, total: body.pendingCount, complete: true };
  } catch (error) {
    if (!isNotFound(error)) throw error;
    const jobs = state.jobs ?? (await refreshJobs());
    return { songs: jobs?.pending ?? [], total: jobs?.pendingCount ?? 0, complete: false };
  }
}

export async function startScan(tracks?: string[]): Promise<{ started: boolean; progressId?: string | null; total?: number }> {
  const result = await apiPost("/api/lyrics/scan", { body: { tracks: tracks?.map(splitRelPath) ?? [] } });
  void refreshJobs().then(schedule);
  return result;
}

export async function setAutoFetch(autoFetch: boolean): Promise<boolean> {
  const result = await apiPut("/api/lyrics/config", { body: { autoFetch } });
  void refreshJobs().then(schedule);
  return result.autoFetch;
}

// ---------------------------------------------------------------- engine

export function installEngine(target: "engine" | "lyrics" | "stems" | "analysis" | "gpu" = "engine"): Promise<{ progressId: string }> {
  return apiPost("/api/lyrics/engine/install", { body: { target } }).then((r) => {
    void refreshJobs().then(schedule);
    return r as { progressId: string };
  });
}

export interface TranscribeTrack {
  relPath: string;
  /** A catalog's text-only hit to align instead of transcribing. */
  text?: string | null;
}

export async function transcribe(tracks: TranscribeTrack[], isolateVocals = true): Promise<{ progressId: string; total: number }> {
  // Alignment must see the committed source document, not a queued replacement.
  if (localState.enabled) {
    const scope = await initializeLocalLyrics();
    await drainLocal();
    for (const track of tracks) {
      if (scope && (await readLocal(scope, track.relPath))?.pending) {
        throw new Error(i18n.t("Sync local changes before aligning lyrics"));
      }
    }
  }
  const result = await apiPost("/api/lyrics/transcribe", {
    body: {
      tracks: tracks.map((t) => ({ ...splitRelPath(t.relPath), text: t.text ?? null })),
      isolateVocals,
    },
  });
  void refreshJobs().then(schedule);
  return result;
}

export async function transcribePending(isolateVocals = true): Promise<{ progressId: string; total: number }> {
  const result = await apiPost("/api/lyrics/transcribe/pending", { body: { isolateVocals } });
  void refreshJobs().then(schedule);
  return result;
}

export async function cancelEngineRun(progressId: string): Promise<boolean> {
  const result = await apiPost("/api/lyrics/transcribe/{progress_id}/cancel", { params: { path: { progress_id: progressId } } });
  void refreshJobs().then(schedule);
  return Boolean((result as { cancelled: boolean }).cancelled);
}

/** One job's tracker snapshot; `null` once the tracker has forgotten it. */
export async function jobProgress(progressId: string): Promise<JobProgress | null> {
  try {
    return (await apiGet("/api/download-progress/{progress_id}", { params: { path: { progress_id: progressId } } })) as JobProgress;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

// ----------------------------------------------------------------- hooks

export function useLyricsFor(relPath: string | null) {
  const readDoc = () => relPath ? state.docs[relPath] : undefined;
  const readKnown = () => Boolean(relPath && relPath in state.docs);
  const doc = useSyncExternalStore(subscribe, readDoc, readDoc);
  const known = useSyncExternalStore(subscribe, readKnown, readKnown);
  return { doc: doc ?? null, known };
}

// Narrow subscriptions keep a jobs tick or an unrelated lyric document from
// re-rendering the app shell, transport and overlays that do not read it.
export function useLyricsOverlayRelPath() {
  // The shell mounts this subscription even while the lyrics UI stays closed.
  useEffect(() => { void initializeLocalLyrics(); }, []);
  const read = () => state.overlayRelPath;
  return useSyncExternalStore(subscribe, read, read);
}

export function useLyricsReviewLine() {
  const read = () => state.reviewLine;
  return useSyncExternalStore(subscribe, read, read);
}

export function useLyricsModalMode(relPath: string | null) {
  const read = () => state.modalRelPath === relPath ? state.modalMode || "search" : "search";
  return useSyncExternalStore(subscribe, read, read);
}

export function useLyricsModalRelPath() {
  const read = () => state.modalRelPath;
  return useSyncExternalStore(subscribe, read, read);
}

export function useHasLyrics(relPath: string | null) {
  const read = () => Boolean(relPath && state.docs[relPath]);
  return useSyncExternalStore(subscribe, read, read);
}

export function useLyricsJobs() {
  const read = () => state.jobs;
  return useSyncExternalStore(subscribe, read, read);
}

export function useLyricsJobsError() {
  const read = () => state.jobsError;
  return useSyncExternalStore(subscribe, read, read);
}

/** The original failure, so settings can distinguish an older nest from a failed request. */
export function useLyricsJobsFailure() {
  const read = () => state.jobsFailure;
  return useSyncExternalStore(subscribe, read, read);
}

/** Reset for tests. */
export function __resetLyricsStoreForTest() {
  stopOfflineLyrics?.(); stopOfflineLyrics = undefined;
  localGeneration++;
  localController.abort(); localController = new AbortController();
  clearTimeout(localTimer);
  removeIdentityListener?.(); removeIdentityListener = undefined;
  broadcast?.close(); broadcast = undefined;
  window.removeEventListener("online", retryLocalLyrics);
  localScope = null; localInit = null;
  localState = { enabled: readLocalPreference(), rows: [], error: "" }; emitLocal();
  state = { docs: {}, overlayRelPath: null, modalRelPath: null, jobs: null, jobsError: null };
  inflight.clear();
  validations.clear(); attempts.clear(); indexRevision = undefined; jobsRevision = undefined;
  stopJobsPoll?.(); stopJobsPoll = undefined;
  jobsWatchers = 0;
  listeners.forEach((fn) => fn());
}
