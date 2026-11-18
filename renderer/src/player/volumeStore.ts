import { useSyncExternalStore } from 'react';

/** Device preference, shared across accounts. Stable localStorage key stores a
 * decimal gain in [0, 1]; zero is silence. There is no separate mute control.
 * The singleton survives provider remounts; storage restores it on launch. */
const VOLUME_KEY = 'krobi.outputVolume';
function readVolume(): number {
  try {
    const saved = localStorage.getItem(VOLUME_KEY);
    const value = saved === null || saved.trim() === '' ? NaN : Number(saved);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
  } catch { return 1; }
}
let volume = readVolume();
const listeners = new Set<() => void>();
export const getVolume = () => volume;
export function subscribeVolume(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function setVolume(value: number): void {
  if (!Number.isFinite(value)) return;
  const next = Math.max(0, Math.min(1, value));
  if (next === volume) return;
  volume = next;
  try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* Retain the session preference when storage is unavailable. */ }
  listeners.forEach(listener => listener());
}
export function useVolume(): number {
  return useSyncExternalStore(subscribeVolume, getVolume, getVolume);
}
