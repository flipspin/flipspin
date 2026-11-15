import { poll as pollInterval, startPoll } from '../data/poll'
import { useSyncExternalStore } from "react";
import { parseLyrics } from "./lrc";
import { isApiError, serverDetail } from "../data";
import { cancelEngineRun, alignLyrics, jobProgress, loadLyrics, refreshJobs, transcribe, type SavePayload, type LyricsDoc } from "./lyricsStore";

export interface SyncRun {
  startedAt?: number;
  progressId?: string;
  selection?: { id: string; payload: SavePayload };
  phase: string;
  percent?: number | null;
  running: boolean;
  error?: string;
}
let runs: Record<string, SyncRun> = {};
const listeners = new Set<() => void>();
const timers = new Map<string, () => void>();
let generation = 0;
const serials: Record<string, number> = {};
function set(relPath: string, run: SyncRun) {
  runs = { ...runs, [relPath]: run };
  listeners.forEach((fn) => fn());
}
function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function useSyncRun(relPath: string) {
  return useSyncExternalStore(subscribe, () => runs[relPath], () => runs[relPath]);
}

/** One run per song, shared by both lyrics surfaces and retained across close/reopen. */
export async function startSync(relPath: string, text: string | null) {
  return trackRun(relPath, () => transcribe([{ relPath, text }]));
}

export async function startSelectionSync(relPath: string, id: string, payload: SavePayload) {
  return trackRun(relPath, () => alignLyrics(relPath, payload), { id, payload });
}

/** Explicit re-timing changes stamps, preserving the current words and edit lock. */
export function startCurrentSync(relPath: string, doc: LyricsDoc) {
  const repeatedStamps = /\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\s*\[\d{1,3}:\d{2}/.test(doc.text);
  const text = doc.kind !== "synced" ? doc.text : repeatedStamps
    ? parseLyrics(doc.text).map(line => line.text).join("\n") : doc.text
    .split(/\r?\n/)
    .filter(line => !/^\s*\[(?:ti|ar|al|au|by|re|ve|length|offset):.*\]\s*$/i.test(line))
    .map(line => line.replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]|<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g, ""))
    .join("\n");
  return startSelectionSync(relPath, "current", {
    kind: "plain", text, source: doc.source, providerRef: doc.providerRef,
    edited: doc.edited, force: Boolean(doc.edited), expectedRevision: doc.revision ?? undefined,
  });
}

async function trackRun(relPath: string, begin: () => Promise<{ progressId: string }>, selection?: SyncRun["selection"]) {
  if (runs[relPath]?.running) return;
  const startedAt = Date.now();
  const currentGeneration = generation;
  const serial = serials[relPath] = (serials[relPath] ?? 0) + 1;
  const stale = () => generation !== currentGeneration || serials[relPath] !== serial;
  set(relPath, { startedAt, selection, running: true, phase: "en cola" });
  try {
    const { progressId } = await begin();
    if (stale()) return;
    set(relPath, { startedAt, selection, progressId, running: true, phase: "en cola" });
    let stop = () => {};
    const poll = async () => {
      if (stale()) { stop(); if (timers.get(relPath) === stop) timers.delete(relPath); return; }
      try {
        const snap = await jobProgress(progressId);
        if (stale()) return;
        if (!snap || snap.terminal) {
          stop(); if (timers.get(relPath) === stop) timers.delete(relPath);
          await loadLyrics(relPath, { force: true });
          if (stale()) return;
          set(relPath, { startedAt, selection, running: false, phase: "", error: snap && (snap.succeeded ?? 0) > 0 ? undefined : snap?.failures?.[0]?.reason || "failed" });
          if (runs[relPath]?.error) console.error("Lyrics alignment failed", runs[relPath].error);
          void refreshJobs();
          return;
        }
        const active = Object.values(snap.active ?? {})[0];
        set(relPath, { startedAt, selection, progressId, running: true, phase: active?.phase || "en cola", percent: active?.percent });
      } catch {
        if (stale()) return;
        // A transport failure is not a failed job. Keep polling the same id.
        set(relPath, { startedAt, selection, progressId, running: true, phase: "", error: "connection" });
      }
      if (stale()) return;

    };
    stop = startPoll(() => pollInterval('active', !stale(), 1500, false), poll, false);
    timers.set(relPath, stop);
    if (pollInterval('active', true) !== false) await poll();
  } catch (error) {
    if (stale()) return;
    console.error("Lyrics alignment failed", error);
    set(relPath, { startedAt, selection, running: false, phase: "", error: isApiError(error) ? serverDetail(error) || error.message : error instanceof Error ? error.message : "failed" });
  }
}

/** Cancel the active job and invalidate its in-flight progress response. */
export async function cancelSync(relPath: string) {
  const run = runs[relPath];
  if (!run?.running || !run.progressId) return;
  if (await cancelEngineRun(run.progressId)) {
    clearSyncRun(relPath);
    await loadLyrics(relPath, { force: true });
  }
}

export function clearSyncRun(relPath: string) {
  timers.get(relPath)?.(); timers.delete(relPath);
  serials[relPath] = (serials[relPath] ?? 0) + 1;
  const { [relPath]: removed, ...remaining } = runs;
  void removed;
  runs = remaining;
  listeners.forEach(fn => fn());
}

export function __resetSyncRunsForTest() {
  generation++;
  timers.forEach(stop => stop());
  timers.clear();
  runs = {};
  Object.keys(serials).forEach(key => delete serials[key]);
  listeners.forEach((fn) => fn());
}
