import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { STORAGE_BASE, STORAGE_NOW, STORAGE_QUEUE, type PlayerTrack } from "./playerQueue";

// How long the queue's localStorage write waits for further changes.
const QUEUE_PERSIST_DELAY_MS = 500;

/** A string preference read from localStorage once and written back on change. */
export function useStoredString(key: string, fallback: string) {
  const [value, setValue] = useState(() => localStorage.getItem(key) || fallback);
  useEffect(() => {
    localStorage.setItem(key, value);
  }, [key, value]);
  return [value, setValue] as const;
}

/** Coalesce synchronous queue writes during bursts and flush on pagehide.
 * Run after the restore effect so the initial null track cannot erase saved playback. */
export function usePersistedQueue(
  nowPlaying: PlayerTrack | null,
  queue: PlayerTrack[],
  baseQueueRef: MutableRefObject<PlayerTrack[]>,
) {
  const persistQueueTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const persistQueue = useCallback(() => {
    persistQueueTimer.current = null;
    try {
      localStorage.setItem(STORAGE_QUEUE, JSON.stringify(queueRef.current));
      // baseQueueRef is mutated in the same handlers that call setQueue, so it's
      // current by the time this runs; persist it too.
      localStorage.setItem(STORAGE_BASE, JSON.stringify(baseQueueRef.current));
    } catch { /* ignore */ }
  }, [baseQueueRef]);

  useEffect(() => {
    if (nowPlaying) {
      try {
        localStorage.setItem(STORAGE_NOW, JSON.stringify(nowPlaying));
      } catch { /* ignore */ }
    } else {
      localStorage.removeItem(STORAGE_NOW);
    }
  }, [nowPlaying]);

  useEffect(() => {
    if (persistQueueTimer.current) clearTimeout(persistQueueTimer.current);
    persistQueueTimer.current = setTimeout(persistQueue, QUEUE_PERSIST_DELAY_MS);
  }, [queue, persistQueue]);

  useEffect(() => {
    const flush = () => {
      if (persistQueueTimer.current) {
        clearTimeout(persistQueueTimer.current);
        persistQueue();
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [persistQueue]);
}
