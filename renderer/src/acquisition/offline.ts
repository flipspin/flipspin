import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { bridge, hasBridge } from '../bridge';
import type { OfflineTrackStatus } from '../lib/ipc';
import { subscribe as subscribeIdentity } from '@state/identityStore';

let state: Record<string, OfflineTrackStatus> = {};
const listeners = new Set<() => void>();
const trackListeners = new Map<string, Set<() => void>>();
const keys = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | undefined;
let stop: (() => void) | undefined;
let generation = 0;
const pendingPins = new Map<string, OfflineTrackStatus>();
/** Bridge the landing receipt to the shell's durable queued row, including IPC
 * queued behind sibling receipts. A failed/cancelled append releases the ring. */
export function queueOfflinePin(key: string) {
  const version = generation;
  const previous = state[key];
  const pending: OfflineTrackStatus = { key, pool: 'offline', state: 'en fila', bytes: 0, etag: null, verifiedAt: null, lastPlayedAt: null, error: null };
  if (!isDownloaded(previous)) {
    pendingPins.set(key, pending);
    publish({ ...state, [key]: pending });
  }
  return async () => {
    if (version !== generation || pendingPins.get(key) !== pending) return;
    // Keep the published ring until the shell's persisted status arrives.
    pendingPins.delete(key);
    await refreshOffline();
  };
}
function publish(next: Record<string, OfflineTrackStatus>) {
  const previous = state;
  state = next;
  listeners.forEach(l => l());
  trackListeners.forEach((subscribers, key) => {
    if (previous[key] !== next[key]) subscribers.forEach(l => l());
  });
}
function sameStatus(a: OfflineTrackStatus, b: OfflineTrackStatus) {
  return a && Object.keys(b).every(key => a[key] === b[key]);
}
export async function refreshOffline() {
  if (!hasBridge()) return;
  const version = generation;
  try {
    const next = await bridge().invoke('offline:status', { keys: [...keys.keys()] });
    if (generation !== version) return;
    // IPC returns new objects even for unchanged files. Retain those snapshots
    // so a refresh for another key cannot re-render every mounted song.
    const tracks = Object.fromEntries(next.tracks.map(t => [t.key, sameStatus(state[t.key], t) ? state[t.key] : t]));
    pendingPins.forEach((pending, key) => {
      if (!tracks[key] || ['fallido', 'ya no está en el nido'].includes(tracks[key].state)) tracks[key] = pending;
    });
    publish(tracks);
  } catch { /* Status is unavailable in the plain web app. */ }
}
function schedule() {
  if (timer !== undefined || !hasBridge()) return;
  timer = setTimeout(() => { timer = undefined; void refreshOffline(); }, 0);
}
subscribeIdentity(() => { generation++; pendingPins.clear(); publish({}); schedule(); });
function start() {
  if (!stop && hasBridge()) stop = bridge().on('offline:changed', schedule);
}
function stopIfUnused() {
  if (listeners.size || trackListeners.size) return;
  stop?.(); stop = undefined; clearTimeout(timer); timer = undefined;
}
function register(list: string[]) {
  let added = false;
  list.forEach(key => { if (!keys.has(key)) added = true; keys.set(key, (keys.get(key) || 0) + 1); });
  // All subscriptions from this commit register before the one scheduled read.
  if (added) schedule();
  return () => list.forEach(key => { const n = keys.get(key) - 1; if (n) keys.set(key, n); else keys.delete(key); });
}
function subscribe(listener: () => void) {
  listeners.add(listener); start();
  return () => { listeners.delete(listener); stopIfUnused(); };
}
export function useOffline(trackKeys: string[]) {
  const key = JSON.stringify(trackKeys.filter(Boolean));
  useEffect(() => register(JSON.parse(key)), [key]);
  return useSyncExternalStore(subscribe, () => state, () => state);
}
/** Per-key subscription and snapshot; registration shares the collection batch. */
export function useOfflineTrack(key?: string) {
  const source = useMemo(() => ({
    subscribe(listener: () => void) {
      if (!key) return () => {};
      const subscribers = trackListeners.get(key) ?? new Set<() => void>();
      trackListeners.set(key, subscribers); subscribers.add(listener);
      start();
      const unregister = register([key]);
      return () => {
        unregister(); subscribers.delete(listener);
        if (!subscribers.size) trackListeners.delete(key);
        stopIfUnused();
      };
    },
    getSnapshot: () => state[key],
  }), [key]);
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}
export const isDownloaded = (s?: OfflineTrackStatus) => !!s && s.pool === 'offline' && (['descargado', 'desactualizado'].includes(s.state) || (s.state === 'ya no está en el nido' && s.verifiedAt != null));
