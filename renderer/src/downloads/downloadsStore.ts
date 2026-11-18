import { poll } from '../data/poll'
import { watchChanges } from '../data/changeListeners'
/**
 * Household jobs, with the ledger as the source of truth. The legacy download
 * entry points stay here so acquisitions/imports still get immediate progress.
 * Only GET /api/jobs decides membership, order, state, actions and retention.
 */
import { onlineManager } from "@tanstack/react-query";
import { announceLibraryChanged } from "@lib/libraryEvents";
import { apiUrl } from "@lib/api";
import { subscribeToken } from "@lib/authToken";
import { apiGet, apiPost, getApiClient } from "../data";
import type { components } from "../api/generated/schema";

export type JobView = components["schemas"]["JobView"];
type ItemView = components["schemas"]["ItemView"];
export interface Failure {
  index: number;
  item: string;
  title: string | null;
  artist: string | null;
  durationS: number | null;
  query: string | null;
  kind: string;
  reason: string | null;
  suggestions: string[];
  retriedAs: string | null;
}
export type Job = JobView & {
  terminal: boolean;
  completed: number;
  failures: Failure[];
  selfStreamed?: boolean;
};
interface Snapshot {
  total?: number;
  completed?: number;
  succeeded?: number | null;
  failed?: number | null;
  percentage?: number;
  terminal?: boolean;
  active?: Record<string, { phase?: string; percent?: number }>;
  failures?: Failure[];
}
interface Store {
  jobs: Job[];
  retry: { jobId: string; failure: Failure } | null;
  degraded: string[];
  unavailable: boolean;
}

let state: Store = { jobs: [], retry: null, degraded: [], unavailable: false };
const listeners = new Set<() => void>();
const streams = new Map<string, EventSource>();
let etag: string | null = null;
let identity = 0;
let stopReconcilePoll: (() => void) | undefined;
let reconciling = false;
let reconcileInFlight: Promise<void> | null = null;

export function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getState() { return state; }
function set(patch: Partial<Store>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}
function closeStream(id: string) {
  streams.get(id)?.close();
  streams.delete(id);
}
export function isLive(job: JobView) {
  return job.state === "running" || job.state === "queued" || job.state === "waiting";
}
function adopt(row: JobView, known?: Job): Job {
  return { ...row, terminal: !isLive(row), completed: row.succeeded + row.failed + row.skipped,
    failures: known?.attempt === row.attempt ? known.failures : [], selfStreamed: known?.selfStreamed };
}
function provisional(id: string, label: string, total = 0): Job {
  return adopt({ id, label, kind: "download", state: "queued", total, succeeded: 0, failed: 0,
    skipped: 0, percent: 0, phase: null, item: null, waitingOn: null, startedAt: null,
    endedAt: null, attempt: 1, failedCount: 0, canCancel: false, canRetry: false });
}

/** Local removal remains for legacy callers; the panel clears on the server. */
export function dismiss(id: string) {
  closeStream(id);
  set({ jobs: state.jobs.filter((job) => job.id !== id) });
}
export async function clearJob(id: string) {
  await apiPost("/api/jobs/{job_id}/clear", { params: { path: { job_id: id } } });
  await refresh();
}
export async function dismissFinished() {
  const generation = identity;
  await apiPost("/api/jobs/clear");
  if (generation !== identity) return;
  // Publish the acknowledged clear before polling; an older response or a
  // failed refresh must not resurrect the finished rows.
  identity++; reconcileInFlight = null; etag = null;
  state.jobs.filter(job => !isLive(job)).forEach(job => closeStream(job.id));
  set({ jobs: state.jobs.filter(isLive) });
  await refresh();
}
export async function cancelJob(id: string) {
  await apiPost("/api/jobs/{job_id}/cancel", { params: { path: { job_id: id } } });
  await refresh();
}
export async function retryJob(id: string, attempt: number) {
  await apiPost("/api/jobs/{job_id}/retry", { params: { path: { job_id: id } }, body: { attempt } });
  await refresh();
}

// A poll begun before a mutation can carry an older list. Read again after it.
async function refresh() {
  if (reconcileInFlight) await reconcileInFlight;
  await reconcile();
  scheduleNextReconcile();
}

export function track({ id, label, total = 0, selfStreamed = false }: {
  id: string; label?: string; source?: string; total?: number; selfStreamed?: boolean;
}) {
  if (!id) return;
  if (!state.jobs.some((job) => job.id === id)) {
    set({ jobs: [...state.jobs, { ...provisional(id, label || "", total), selfStreamed }] });
  }
  // Reconcile immediately: callers need not know the job's kind or capabilities.
  void refresh();
}

/** SSE supplements live percent/phase only; terminal transitions come from the ledger. */
export function report(id: string, snapshot: Snapshot) {
  if (!id) return;
  const known = state.jobs.find((job) => job.id === id);
  // Callers register first. In particular, ignore a self-owned stream left
  // over from before sign-in changed the identity and discarded its rows.
  if (!known) return;
  const job = known;
  const [item, detail] = Object.entries(snapshot.active || {})[0] || [null, null];
  const updated: Job = { ...job, completed: snapshot.completed ?? job.completed,
    percent: detail?.phase === "downloading" && detail.percent != null ? detail.percent : snapshot.percentage ?? job.percent,
    phase: detail?.phase || null, item,
    failures: snapshot.failures || job.failures };
  set({ jobs: state.jobs.map((row) => row.id === id ? updated : row) });
  if (snapshot.terminal) {
    closeStream(id);
    void refresh();
    window.dispatchEvent(new CustomEvent("downloads-finished", { detail: { id } }));
  }
}
function watch(id: string) {
  if (!onlineManager.isOnline() || streams.has(id) || typeof window.EventSource !== "function") return;
  const source = new EventSource(apiUrl(`/api/download-progress-stream/${encodeURIComponent(id)}`));
  streams.set(id, source);
  source.onmessage = (event) => {
    // A queued event from a closed socket must not restore another identity's row.
    if (streams.get(id) !== source) return;
    try { report(id, JSON.parse(event.data)); } catch { /* Ignore malformed events. */ }
  };
  source.onerror = () => closeStream(id);
}

/** A 304 preserves the exact snapshot; a 200 replaces it in server order. */
export function reconcile(): Promise<void> {
  if (poll('idle') === false) return Promise.resolve();
  if (!onlineManager.isOnline()) return Promise.resolve();
  if (reconcileInFlight) return reconcileInFlight;
  const generation = identity;
  const pending = (async () => {
    try {
      const client = await getApiClient();
      if (generation !== identity) return;
      const { data, response } = await client.GET("/api/jobs", {
        headers: etag ? { "If-None-Match": etag } : {},
      });
      if (generation !== identity) return;
      if (response.status === 304) {
        if (state.unavailable) set({ unavailable: false });
        state.jobs.forEach((job) => { if (job.state === "running" && !job.selfStreamed) watch(job.id); });
        return;
      }
      if (!response.ok || !data) throw new Error("jobs-unavailable");
      etag = response.headers.get("ETag");
      const jobs = data.jobs.map((row) => adopt(row, state.jobs.find((job) => job.id === row.id)));
      for (const id of streams.keys()) {
        if (!jobs.some((job) => job.id === id && job.state === "running")) closeStream(id);
      }
      const changed = jobs.find(job => ['download', 'import', 'upload'].includes(job.kind)
        && ['succeeded', 'partial'].includes(job.state)
        && !state.jobs.some(old => old.id === job.id && old.attempt === job.attempt && old.state === job.state));
      set({ jobs, degraded: data.degraded, unavailable: false });
      if (changed) announceLibraryChanged(`trabajo ${changed.kind} ${changed.id} ${changed.state}:${changed.attempt}`);
      jobs.forEach((job) => { if (job.state === "running" && !job.selfStreamed) watch(job.id); });
    } catch {
      if (generation === identity) set({ unavailable: true });
    }
  })();
  reconcileInFlight = pending;
  void pending.finally(() => { if (reconcileInFlight === pending) reconcileInFlight = null; });
  return pending;
}

/** Never carry an ETag or visible rows across an account switch. */
export function resetForIdentityChange() {
  identity += 1;
  streams.forEach((stream) => stream.close());
  streams.clear();
  etag = null;
  reconcileInFlight = null;
  set({ jobs: [], retry: null, degraded: [], unavailable: false });
  void reconcile().then(scheduleNextReconcile);
}
function scheduleNextReconcile() {
  if (reconciling && !stopReconcilePoll) stopReconcilePoll = watchChanges(['jobs', 'helpers'], reconcile, false);
}
export function startReconciling() {
  if (reconciling) return;
  reconciling = true;
  stopReconcilePoll = watchChanges(['jobs', 'helpers'], reconcile);
}
export function stopReconciling() {
  reconciling = false;
  streams.forEach(stream => stream.close());
  streams.clear();
  stopReconcilePoll?.(); stopReconcilePoll = undefined;
}

function failureFromItem(row: ItemView): Failure {
  const d = row.detail;
  const text = (key: string) => typeof d[key] === "string" ? d[key] as string : null;
  return { index: row.idx, item: row.item, title: text("title"), artist: text("artist"),
    durationS: typeof d.durationS === "number" ? d.durationS : null, query: text("query"),
    kind: text("kind") || row.reason || "error", reason: text("reason") || row.reason,
    suggestions: Array.isArray(d.suggestions) ? d.suggestions.filter((s): s is string => typeof s === "string") : [],
    retriedAs: text("retriedAs") };
}
export async function loadFailures(id: string, attempt: number) {
  const generation = identity;
  const { items } = await apiGet("/api/jobs/{job_id}/items", {
    params: { path: { job_id: id }, query: { state: "failed" } },
  });
  if (generation !== identity) return;
  set({ jobs: state.jobs.map((job) => job.id === id && job.attempt === attempt
    ? { ...job, failures: items.map(failureFromItem) } : job) });
}
export function openRetry(jobId: string, failure: Failure) { set({ retry: { jobId, failure } }); }
export function closeRetry() { if (state.retry) set({ retry: null }); }
export function markRetried(jobId: string, index: number, retryId: string, label: string) {
  set({ jobs: state.jobs.map((job) => job.id !== jobId ? job : { ...job,
    failures: job.failures.map((failure) => failure.index === index ? { ...failure, retriedAs: retryId } : failure) }) });
  track({ id: retryId, label, source: "YT", total: 1 });
}

if (typeof window !== "undefined") {
  subscribeToken(resetForIdentityChange);
  window.addEventListener("pagehide", () => {
    streams.forEach((stream) => stream.close());
    streams.clear();
    stopReconciling();
  });
}
