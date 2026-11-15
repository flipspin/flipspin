import type { PlaybackPort } from '../player/engine/PlaybackPort';
import { useEffect, useMemo, type RefObject } from "react";
import { LYRICS_TICK_S } from "./overlayModel";

/** The playhead as a tiny external store, so only what reads it re-renders. */
export interface LyricClock {
  read: () => number;
  subscribe: (fn: () => void) => () => void;
}

/**
 * Follows `audioRef`'s position at LYRICS_TICK_S while `running`, and on every
 * seek/timeupdate while it is not. Reads 0 when the song on screen is not the
 * one playing (`matching` false).
 */
export function useLyricClock(audioRef: RefObject<PlaybackPort | null>, matching: boolean, running: boolean): LyricClock {
  const clock = useMemo(() => {
    let position = matching ? (audioRef.current?.currentTime || 0) : 0;
    const listeners = new Set<() => void>();
    return {
      read: () => position,
      subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
      update: () => {
        const next = matching ? (audioRef.current?.currentTime || 0) : 0;
        if (next !== position) { position = next; listeners.forEach((fn) => fn()); }
      },
    };
  }, [audioRef, matching]);
  useEffect(() => {
    const el = audioRef.current;
    if (!matching || !el) return;
    let frame = 0;
    let last = -1;
    const tick = () => {
      const position = el.currentTime;
      if (Math.abs(position - last) >= LYRICS_TICK_S) { last = position; clock.update(); }
      frame = requestAnimationFrame(tick);
    };
    clock.update();
    // Seeks while paused must still update the active line and position.
    el.addEventListener("seeked", clock.update);
    el.addEventListener("timeupdate", clock.update);
    if (running) frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("seeked", clock.update);
      el.removeEventListener("timeupdate", clock.update);
    };
  }, [audioRef, matching, running, clock]);
  return clock;
}
