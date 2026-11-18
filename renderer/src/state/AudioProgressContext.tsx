import type { PlaybackPort } from '../player/engine/PlaybackPort';
import React, { createContext, useContext, useEffect, useMemo, useState, type RefObject } from "react";

export interface AudioProgressValue {
  progress: number;
  setProgress: React.Dispatch<React.SetStateAction<number>>;
  duration: number;
  setDuration: React.Dispatch<React.SetStateAction<number>>;
}

// Isolate playhead ticks from queue and app consumers so position updates
// do not rerender the shell or resend the queue to the player window.
const AudioProgressContext = createContext<AudioProgressValue | undefined>(undefined);
const AudioDurationContext = createContext(0);

export function AudioProgressProvider({
  audioRef,
  children,
}: {
  audioRef: RefObject<PlaybackPort | null>;
  children?: React.ReactNode;
}) {
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  // The stable ref points to the engine; duration and position share its clock.
  useEffect(() => {
    const el = audioRef?.current;
    if (!el) return;
    const onTime = () => setProgress(el.currentTime || 0);
    const onLoaded = () => setDuration(el.duration || 0);
    const onEmptied = () => {
      setProgress(0);
      setDuration(0);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("durationchange", onLoaded);
    el.addEventListener("emptied", onEmptied);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("durationchange", onLoaded);
      el.removeEventListener("emptied", onEmptied);
    };
  }, [audioRef]);

  const value = useMemo(() => ({ progress, setProgress, duration, setDuration }), [progress, duration]);

  return (
    <AudioProgressContext.Provider value={value}>
      <AudioDurationContext.Provider value={duration}>{children}</AudioDurationContext.Provider>
    </AudioProgressContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAudioProgress(): AudioProgressValue {
  const context = useContext(AudioProgressContext);
  if (context === undefined) {
    throw new Error("useAudioProgress must be used within an AudioPlayerProvider");
  }
  return context;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAudioDuration(): number {
  return useContext(AudioDurationContext);
}
