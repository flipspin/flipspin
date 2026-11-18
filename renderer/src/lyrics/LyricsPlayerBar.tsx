import React, { useEffect, useState, useSyncExternalStore } from "react";
import type { TFunction } from "i18next";
import { ChevronDown, ChevronUp, ListMusic, MicVocal, Pause, Play, Shuffle, SkipBack, SkipForward, Volume2 } from "lucide-react";
import { useAudioProgress } from "@state/AudioPlayerContext";
import { formatTime } from "@lib/formatting";
import { Track } from "./LyricsTrackSlider";
import type { AudioPlayerValue, AudioProgressValue } from "./overlayModel";
import type { LyricClock } from "./useLyricClock";

/** Use the main playback context so this transport shares queue and playback intent.
 * Opening Queue closes the lyrics view and returns to the main queue. */
export default function LyricsPlayerBar({ t, player, clock, total, onClose, waveOpen, onToggleWave }: {
  t: TFunction;
  player: AudioPlayerValue;
  clock: LyricClock;
  total: number;
  onClose: () => void;
  waveOpen: boolean;
  onToggleWave: () => void;
}) {
  const position = useSyncExternalStore(clock.subscribe, clock.read);
  const { audioRef, isPlaying, setIsPlaying, shuffleEnabled, toggleShuffle, goNext, goPrevious, queue = [] } = player;
  const { setProgress } = useAudioProgress() as AudioProgressValue;
  const [volume, setVolume] = useState(() => audioRef?.current?.volume ?? 1);
  useEffect(() => {
    const engine = audioRef?.current;
    if (!engine) return;
    const changed = () => setVolume(engine.volume);
    engine.addEventListener('volumechange', changed);
    return () => engine.removeEventListener('volumechange', changed);
  }, [audioRef]);

  const seek = (frac: number) => {
    const el = audioRef?.current;
    if (!el || !total) return;
    const secs = frac * total;
    el.currentTime = secs;
    setProgress(secs);
  };
  const changeVolume = (v: number) => {
    setVolume(v);
    if (audioRef?.current) audioRef.current.volume = v;
  };
  const showQueue = () => {
    onClose();
    window.setTimeout(() => window.dispatchEvent(new Event("krobi-show-queue")), 260);
  };

  return (
    <footer className="lyrics-bar">
      <button type="button" className={`lyrics-wave-tab${waveOpen ? " is-on" : ""}`} onClick={onToggleWave} aria-expanded={waveOpen} title={waveOpen ? t("Hide wave") : t("Show wave")}>
        {waveOpen ? <ChevronDown size={12} strokeWidth={3} aria-hidden /> : <ChevronUp size={12} strokeWidth={3} aria-hidden />}
        {t("Wave")}
      </button>
      <div />
      <div className="lyrics-bar-mid">
        <div className="lyrics-bar-controls">
          <button type="button" className={`lyrics-tb${shuffleEnabled ? " is-on" : ""}`} onClick={toggleShuffle} aria-pressed={shuffleEnabled} title={t("Shuffle")}>
            <Shuffle size={16} strokeWidth={2.5} aria-hidden />
          </button>
          <button type="button" className="lyrics-tb" onClick={() => goPrevious?.()} title={t("Previous")}>
            <SkipBack size={16} strokeWidth={2.5} aria-hidden />
          </button>
          <button type="button" className="lyrics-tb lyrics-tb--play" onClick={() => setIsPlaying((p) => !p)} title={t("Play / pause")}>
            {isPlaying ? <Pause size={22} strokeWidth={2.5} fill="currentColor" aria-hidden /> : <Play size={22} strokeWidth={2.5} fill="currentColor" style={{ marginLeft: 2 }} aria-hidden />}
          </button>
          <button type="button" className="lyrics-tb" onClick={() => goNext?.()} title={t("Next")}>
            <SkipForward size={16} strokeWidth={2.5} aria-hidden />
          </button>
          <button type="button" className="lyrics-tb is-on" onClick={onClose} title={t("Close lyrics")}>
            <MicVocal size={16} strokeWidth={2.5} aria-hidden />
          </button>
        </div>
        <div className="lyrics-bar-seek">
          <span>{formatTime(position)}</span>
          <Track value={total > 0 ? position / total : 0} onChange={seek} disabled={!total} ariaLabel={t("Position")} />
          <span className="lyrics-bar-total">{formatTime(total)}</span>
        </div>
      </div>
      <div className="lyrics-bar-side">
        <div className="lyrics-bar-volume">
          <Volume2 size={16} strokeWidth={2.2} aria-hidden />
          <Track value={volume} onChange={changeVolume} ariaLabel={t("Volume")} />
        </div>
        <button type="button" className="lyrics-tb lyrics-bar-queue" onClick={showQueue} title={t("Queue")} aria-label={t("Queue")}>
          <ListMusic size={18} strokeWidth={2.5} aria-hidden />
          {queue.length > 0 && <b>{queue.length}</b>}
        </button>
      </div>
    </footer>
  );
}
