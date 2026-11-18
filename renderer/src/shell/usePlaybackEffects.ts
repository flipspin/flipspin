import type { AudioPlayerValue } from "../state/AudioPlayerContext";
import { playbackEngine } from "../player/engine/PlaybackEngine";
import { useEffect, useRef } from "react";
import { stemPlayer } from "../stems/StemPlayer";
import { stemTrack } from "../stems/stemApi";
import { recordPlay, relPathOf } from "@state/userLibraryStore";
import { recordLocalPlay } from "@lib/playHistory";
import { lyricsKeyOf, openLyricsOrAdd } from "../lyrics/lyricsStore";
import { bootMacAgent } from "../lyrics/macEngine";

/**
 * Everything the shell does around playback that is not drawing: the next
 * song when one ends, reporting a play, the stem player's lifecycle, and the
 * separate player window (state out, actions in).
 */
export function usePlaybackEffects(player: AudioPlayerValue) {
  const { audioRef, isPlaying, selectedTrack, visualizationType, svgWaveformStyle, audioWaveformStyle, queue } = player;

  // Record plays on the playing event: restoring or skipping a queued track does not imply playback.
  const lastPlayReportedRef = useRef<string | null>(null);
  useEffect(() => {
    const el = audioRef?.current;
    if (!el) return;
    let played = 0;
    let previous = el.currentTime;
    const key = selectedTrack?.path || relPathOf(selectedTrack);
    lastPlayReportedRef.current = null;
    const onTime = () => {
      const delta = el.currentTime - previous;
      previous = el.currentTime;
      if (!el.paused && delta > 0 && delta < 2) played += delta;
      const duration = el.duration;
      if (!key || !Number.isFinite(duration) || duration <= 30 || played < Math.min(duration / 2, 240) || lastPlayReportedRef.current === key) return;
      lastPlayReportedRef.current = key;
      recordLocalPlay(selectedTrack);
      if (relPathOf(selectedTrack)) recordPlay(selectedTrack);
    };
    const onSeeking = () => { previous = el.currentTime; };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("seeked", onSeeking);
    return () => { el.removeEventListener("timeupdate", onTime); el.removeEventListener("seeked", onSeeking); };
  }, [audioRef, selectedTrack]);

  // Context creation and resume happen synchronously on the first user gesture.
  useEffect(() => {
    const activate = () => { void playbackEngine.activate().catch(() => {}); void stemPlayer.activate(); };
    document.addEventListener("pointerdown", activate, { once: true });
    document.addEventListener("keydown", activate, { once: true });
    return () => {
      document.removeEventListener("pointerdown", activate);
      document.removeEventListener("keydown", activate);
      stemPlayer.detach();
      playbackEngine.dispose();
    };
  }, []);

  // Promote the selected track's lookahead before updating the new n+1.
  useEffect(() => { stemPlayer.setNext(stemTrack(queue[0] || null)); }, [queue]);

  // Exclude playhead ticks from the window relay: it carries the persisted queue
  // and the separate window does not display playback position.
  useEffect(() => {
    const api = window.desktopAPI;
    if (!api?.sendPlayerState) return;
    api.sendPlayerState({
      selectedTrack,
      isPlaying,
      visualizationType,
      svgWaveformStyle,
      audioWaveformStyle,
      queue: queue ?? [],
    });
  }, [selectedTrack, isPlaying, visualizationType, svgWaveformStyle, audioWaveformStyle, queue]);

  // Rust restores this nest’s worker switch and its separate device credential.
  useEffect(() => bootMacAgent(), []);

  // Apply actions from player window (subscribe once, use refs to avoid duplicate IPC listeners)
  const actionRef = useRef<AudioPlayerValue>(player);
  actionRef.current = player;
  useEffect(() => {
    const api = window.desktopAPI;
    if (!api?.onPlayerAction) return;
    const handler = (data: unknown) => {
      if (!data || typeof data !== "object" || !("type" in data)) return;
      const a = actionRef.current;
      if (data.type === "next") a.goNext?.();
      if (data.type === "prev") a.goPrevious?.();
      if (data.type === "setVisualizationType" && "value" in data && typeof data.value === "string") a.setVisualizationType?.(data.value);
      if (data.type === "setSvgWaveformStyle" && "value" in data && typeof data.value === "string") a.setSvgWaveformStyle?.(data.value);
      if (data.type === "setAudioWaveformStyle" && "value" in data && typeof data.value === "string") a.setAudioWaveformStyle?.(data.value);
      if (data.type === "playQueueItemAt" && "index" in data && typeof data.index === "number") a.playQueueItemAt?.(data.index);
      if (data.type === "removeFromQueue" && "index" in data && typeof data.index === "number") a.removeFromQueue?.(data.index);
      if (data.type === "reorderQueue" && "from" in data && typeof data.from === "number" && "to" in data && typeof data.to === "number") a.reorderQueue?.(data.from, data.to);
      // The player window has no audio element of its own, so its "Lyrics"
      // button asks this window to open the view for whatever is playing.
      if (data.type === "openLyrics") {
        const rel = lyricsKeyOf(a.selectedTrack);
        if (rel) void openLyricsOrAdd(rel);
      }
    };
    const dispose = api.onPlayerAction(handler);
    return () => dispose?.();
  }, []);

  // Dedicated channel for play/pause from player window (Space, cross, cover)
  useEffect(() => {
    const api = window.desktopAPI;
    if (!api?.onPlayerPlayToggle) return;
    const handler = () => {
      const a = actionRef.current;
      if (a.waitingForNest) return;
      if (a.setIsPlaying) {
        a.setIsPlaying((prev) => !prev);
      }
    };
    const dispose = api.onPlayerPlayToggle(handler);
    return () => dispose?.();
  }, []);
}
