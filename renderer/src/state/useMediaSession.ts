import { playbackEngine } from '../player/engine/PlaybackEngine';
import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { nowPlayingMetadata, type PlayerTrack } from "./playerQueue";
import { bridge, hasBridge } from "../bridge";

const mediaSession = (): MediaSession | null =>
  typeof navigator !== "undefined" ? navigator.mediaSession ?? null : null;

/** Media keys and Now Playing observe the engine transport and position. */
export function useMediaSession({
  nowPlaying,
  isPlaying,
  setIsPlaying,
  nextRef,
  prevRef,
}: {
  nowPlaying: PlayerTrack | null;
  isPlaying: boolean;
  setIsPlaying: Dispatch<SetStateAction<boolean>>;
  nextRef: MutableRefObject<() => void>;
  prevRef: MutableRefObject<() => void>;
}) {
  useEffect(() => {
    const ms = mediaSession();
    if (!ms) return;
    const bind = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
      try { ms.setActionHandler(action, fn); } catch { /* action unsupported here */ }
    };
    bind("play", () => setIsPlaying(true));
    bind("pause", () => setIsPlaying(false));
    bind("previoustrack", () => prevRef.current());
    bind("nexttrack", () => nextRef.current());
    bind("seekto", details => { if (details.seekTime !== undefined) playbackEngine.currentTime = details.seekTime; });
    bind("seekbackward", details => { playbackEngine.currentTime -= details.seekOffset || 10; });
    bind("seekforward", details => { playbackEngine.currentTime += details.seekOffset || 10; });
    const position = () => {
      if (!Number.isFinite(playbackEngine.duration) || playbackEngine.duration <= 0) return;
      try { ms.setPositionState({ duration: playbackEngine.duration, position: Math.min(playbackEngine.duration, playbackEngine.currentTime), playbackRate: 1 }); } catch { /* Unsupported WebKit. */ }
    };
    playbackEngine.addEventListener('timeupdate', position);
    playbackEngine.addEventListener('durationchange', position);
    playbackEngine.addEventListener('seeked', position);
    playbackEngine.addEventListener('pause', position);
    return () => {
      playbackEngine.removeEventListener('timeupdate', position);
      playbackEngine.removeEventListener('durationchange', position);
      playbackEngine.removeEventListener('seeked', position);
      playbackEngine.removeEventListener('pause', position);
      (["play", "pause", "previoustrack", "nexttrack", "seekto", "seekbackward", "seekforward"] as const).forEach((a) => bind(a, null));
    };
  }, [setIsPlaying, nextRef, prevRef]);

  // The menu-bar icon's Play/Pause, Next and Previous rows (src-tauri worker_tray.rs).
  useEffect(() => {
    if (!hasBridge()) return;
    return bridge().on("player:command", (command) => {
      if (command === "toggle") setIsPlaying((playing) => !playing);
      else if (command === "next") nextRef.current();
      else if (command === "previous") prevRef.current();
    });
  }, [setIsPlaying, nextRef, prevRef]);

  useEffect(() => {
    const ms = mediaSession();
    if (!ms || typeof window.MediaMetadata !== "function") return;
    if (!nowPlaying) { ms.metadata = null; return; }
    ms.metadata = new window.MediaMetadata(nowPlayingMetadata(nowPlaying));
  }, [nowPlaying]);

  useEffect(() => {
    const ms = mediaSession();
    if (!ms) return;
    try { ms.playbackState = isPlaying ? "playing" : "paused"; } catch { /* older WebKit */ }
  }, [isPlaying]);
}
