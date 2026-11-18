import LyricsVoiceToggle from '../stems/LyricsVoiceToggle';
import { parseTrackPath } from '@lib/api';
import { stemPlayer } from '../stems/StemPlayer';
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { TFunction } from "i18next";
import { ChevronLeft, Disc3, LocateFixed, MicOff, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAudioPlayer, useAudioDuration } from "@state/AudioPlayerContext";
import RealTimeWaveform from "../viz/RealTimeWaveform";
import { currentLineIndex, formatStamp, isSynced, parseLyrics } from "./lrc";
import {
  initializeLocalLyrics,
  useLocalLyricsStatus,
  useLocalLyricsEnabled,
  closeLyrics,
  lyricsKeyOf,
  openLyrics,
  openLyricsModal,
  useLyricsFor,
  useLyricsReviewLine,
  useLyricsOverlayRelPath,
} from "./lyricsStore";
import { sourceLabel } from "./copy";
import { useArtworkPalette } from "./artworkPalette";
import { useVizOpen } from "../viz/vizStore";
import LyricList from "./LyricList";
import LyricsAside from "./LyricsAside";
import LyricsBackdrop from "./LyricsBackdrop";
import LyricsPlayerBar from "./LyricsPlayerBar";
import LyricsSyncControl from "./LyricsSyncControl";
import { BACKDROP_KEY, coverOf, readPref, WAVE_KEY, writePref, type AudioPlayerValue, type LyricsTrack } from "./overlayModel";
import { useLyricClock, type LyricClock } from "./useLyricClock";
import { useLineSync } from "./useLineSync";
import { useLyricOffset } from "./useLyricOffset";
import { openSyncAddons, useLyricsSync } from "./useLyricsSync";
import { useStemEngine } from "./useStemEngine";
import { startCurrentSync } from "./syncRunStore";

// The visualizer's pill reuses the glass track; it has always imported it from here.
export { Track } from "./LyricsTrackSlider";

interface LyricsOverlayProps {
  onOpenInfo?: (track: LyricsTrack) => void;
  onOpenModal?: (relPath: string) => void;
}

/** Keep overlay state outside routes so navigation does not interrupt lyrics.
 * Follow queue changes while open, but preserve a non-playing song opened from an album row.
 * Each renderer window owns its own store and overlay. */
export default function LyricsOverlay({ onOpenModal, onOpenInfo }: LyricsOverlayProps) {
  const { t } = useTranslation();
  const overlayRelPath = useLyricsOverlayRelPath();
  useEffect(() => { void initializeLocalLyrics(); }, []);
  // Karaoke: while this screen is open the stems mix carries over to the
  // next song (and its stems are prepared ahead); elsewhere a new song starts
  // on Original.
  useEffect(() => {
    stemPlayer.setCarryMix(true);
    return () => stemPlayer.setCarryMix(false);
  }, []);
  const { nowPlaying } = useAudioPlayer() as AudioPlayerValue;
  const nowKey = lyricsKeyOf(nowPlaying);
  const lastNowKey = useRef(nowKey);
  useEffect(() => {
    const changed = nowKey !== lastNowKey.current;
    lastNowKey.current = nowKey;
    if (changed && overlayRelPath && nowKey && nowKey !== overlayRelPath) openLyrics(nowKey);
  }, [nowKey, overlayRelPath]);
  if (!overlayRelPath) return null;
  return <Sheet key={overlayRelPath} relPath={overlayRelPath} onOpenInfo={onOpenInfo} onOpenModal={onOpenModal} t={t} />;
}

function Sheet({ relPath, onOpenModal, onOpenInfo, t }: LyricsOverlayProps & { relPath: string; t: TFunction }) {
  const player = useAudioPlayer() as AudioPlayerValue;
  const { audioRef, nowPlaying, selectedTrack } = player;
  const duration = useAudioDuration();
  const { doc, known } = useLyricsFor(relPath);
  const [phase, setPhase] = useState("entering");
  const [following, setFollowing] = useState(true);
  const [syncOpen, setSyncOpen] = useState(false);
  const [backdrop, setBackdrop] = useState(() => readPref(BACKDROP_KEY, "tint"));
  const [waveOpen, setWaveOpen] = useState(() => readPref(WAVE_KEY, "0") === "1");
  // The visualizer covers this view and reads the same analyser: one loop at a time.
  const vizOpen = useVizOpen();
  useEffect(() => writePref(BACKDROP_KEY, backdrop), [backdrop]);
  useEffect(() => writePref(WAVE_KEY, waveOpen ? "1" : "0"), [waveOpen]);
  const reviewLine = useLyricsReviewLine();
  const mainRef = useRef<HTMLElement | null>(null);
  const lineRefs = useRef<Array<HTMLLIElement | null>>([]);

  const track = [nowPlaying, selectedTrack].find((x) => lyricsKeyOf(x) === relPath) || nowPlaying || null;
  const isPlayingThis = lyricsKeyOf(nowPlaying) === relPath;
  const stemEngine = useStemEngine(isPlayingThis ? duration : undefined, !vizOpen);
  const baseLines = useMemo(() => parseLyrics(doc?.text), [doc?.text]);
  const synced = useMemo(() => isSynced(baseLines), [baseLines]);

  const localEnabled = useLocalLyricsEnabled();
  const localStatus = useLocalLyricsStatus(relPath);
  const engine = useLyricsSync(relPath, isPlayingThis ? duration : null, t);
  const sync = useLyricOffset(relPath, doc, synced && !engine.run?.running, localEnabled, `${relPath}:${engine.run?.startedAt ?? ""}`);
  const lineSync = useLineSync(relPath, doc?.text || "", sync.shown, synced && !engine.run?.running, sync.saveShown);
  useEffect(() => { setSyncOpen(false); }, [relPath]);
  const lines = useMemo(() => parseLyrics(doc?.text, sync.shown * 1000), [doc?.text, sync.shown]);

  const clock = useLyricClock(audioRef, isPlayingThis, player.isPlaying && !vizOpen);
  // Only a line transition wakes the list; clock text and transport subscribe separately.
  const current = useSyncExternalStore(clock.subscribe, () => synced ? currentLineIndex(lines, clock.read()) : -1);
  const total = duration || audioRef?.current?.duration || 0;

  const close = useCallback(() => {
    setPhase("closing");
    window.setTimeout(closeLyrics, 240);
  }, []);

  useEffect(() => {
    const id = window.setTimeout(() => setPhase("open"), 380);
    return () => window.clearTimeout(id);
  }, []);

  const seek = useCallback(
    (seconds: number) => {
      const el = audioRef?.current;
      if (!el || !isPlayingThis) return;
      el.currentTime = Math.max(0, Math.min(seconds, el.duration || seconds));
    },
    [audioRef, isPlayingThis],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        if (syncOpen) setSyncOpen(false);
        else close();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seek((audioRef?.current?.currentTime || 0) + 5);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seek((audioRef?.current?.currentTime || 0) - 5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close, seek, audioRef, syncOpen]);

  // Follow the song until the person scrolls: a wheel or touch stops
  // following for good, and only the round button or a click on a line
  // brings it back.
  useEffect(() => {
    if (current < 0 || !following || lineSync.active) return;
    const el = lineRefs.current[current];
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "center", behavior: phase === "open" && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "smooth" : "auto" });
    }
  }, [current, following, phase, lineSync.active]);
  useEffect(() => {
    if (reviewLine == null || !known) return;
    setFollowing(false);
    const line = lineRefs.current[reviewLine];
    line?.scrollIntoView?.({ block: "center", behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    line?.focus({ preventScroll: true });
  }, [reviewLine, relPath, known]);
  const stopFollowing = () => setFollowing(false);
  const seekLine = useCallback((seconds: number) => { setFollowing(true); seek(seconds); }, [seek]);
  const openModal = () => (onOpenModal ?? openLyricsModal)(relPath);

  const cover = coverOf(track);
  const palette = useArtworkPalette(cover);
  const title = track?.title || relPath.split("/").pop();
  const artist = track?.artist || "";
  const source = doc ? sourceLabel(doc, t) : "";
  const empty = !known || !doc || doc.kind === "instrumental" || lines.length === 0;
  // The aligner's review marks, by LRC line in file order; which is the
  // parsed order, since it writes one stamp per line, sorted.
  const lowLines = useMemo(() => new Set(synced ? doc?.lowLines ?? [] : []), [doc?.lowLines, synced]);

  return (
    <div
      className={`lyrics-overlay ${phase}${waveOpen ? " wave-open" : ""}`}
      onKeyDownCapture={lineSync.onKeyDownCapture}
      role="dialog"
      aria-modal="true"
      aria-label={t("Lyrics")}
      style={{ "--lyrics-accent": palette.accent, "--lyrics-base": palette.base } as CSSProperties}
    >
      <LyricsBackdrop cover={backdrop === "tint" ? cover : null} />
      <header className="lyrics-top">
        <button type="button" className="lyrics-close" onClick={close} aria-label={t("Close lyrics")} title={t("Close")}>
          <ChevronLeft size={18} strokeWidth={2.5} />
        </button>
        <div className="lyrics-title">
          <div className="lyrics-song" title={title}>{title}</div>
          <div className="eyebrow lyrics-eyebrow">
            {artist}
            {source ? ` · ${source}` : ""}
            {synced && isPlayingThis && <PositionLabel clock={clock} total={total} />}
          </div>
        </div>
        <div className="lyrics-actions">
          <LyricsVoiceToggle track={(() => { const p = parseTrackPath(relPath); return p.albumName && p.fileName ? { album: p.albumName, file: p.fileName, duration: isPlayingThis ? duration ?? undefined : undefined } : null; })()} visible={!vizOpen} playingThis={isPlayingThis} engine={stemEngine} onOpenAddons={openSyncAddons} />
          <div className="lyrics-seg" role="group" aria-label={t("Lyrics background")}>
            <button type="button" className={backdrop === "solid" ? "is-on" : ""} aria-pressed={backdrop === "solid"} onClick={() => setBackdrop("solid")}>{t("Solid")}</button>
            <button type="button" className={backdrop === "tint" ? "is-on" : ""} aria-pressed={backdrop === "tint"} onClick={() => setBackdrop("tint")}>{t("Cover tint")}</button>
          </div>
          {doc && doc.kind !== "instrumental" && (
            <LyricsSyncControl
              t={t}
              lyric={doc}
              engine={engine}
              onSync={() => { void startCurrentSync(relPath, doc); }}
              open={syncOpen}
              onToggle={() => { if (syncOpen) lineSync.cancel(); setSyncOpen((v) => !v); }}
              onClose={() => { lineSync.cancel(); setSyncOpen(false); }}
              lineSync={lineSync}
              shown={sync.shown}
              onChange={sync.setShown}
              onStep={sync.nudge}
              onReset={sync.reset}
              saveState={localStatus || sync.saveState}
            />
          )}
          <button type="button" className="waveform-btn" onClick={openModal} title={t("Find other lyrics or fix these")}>
            <RefreshCw size={13} strokeWidth={2.5} aria-hidden />
            {t("Change lyrics")}
          </button>
        </div>
      </header>
      <div className="lyrics-body">
        <div className="lyrics-col">
          <main ref={mainRef} className={`lyrics-main${empty ? " lyrics-main--empty" : ""}`} onWheel={stopFollowing} onTouchMove={stopFollowing}>
            {!known && <p className="lyrics-empty">{t("Loading…")}</p>}
            {known && !doc && (
              <div className="lyrics-empty">
                <MicOff size={56} strokeWidth={1.75} aria-hidden />
                <p>{t("No lyrics")}</p>
                <button type="button" className="waveform-btn" onClick={openModal}>{t("Find lyrics")}</button>
              </div>
            )}
            {doc?.kind === "instrumental" && (
              <div className="lyrics-empty">
                <Disc3 size={56} strokeWidth={1.75} aria-hidden />
                <p>{t("instrumental")}</p>
              </div>
            )}
            {doc && lines.length > 0 && (
              <LyricList lines={lines} current={current} synced={synced} lowLines={lowLines} isPlayingThis={isPlayingThis} seek={seekLine} picked={lineSync.picked} onPick={lineSync.active ? lineSync.pick : undefined} lineRefs={lineRefs} t={t} />
            )}
          </main>
          {!following && current >= 0 && !empty && (
            <button
              type="button"
              className="lyrics-refollow"
              onClick={() => setFollowing(true)}
              aria-label={t("Back to the current line")}
              title={t("Back to the current line")}
            >
              <LocateFixed size={18} strokeWidth={2.5} aria-hidden />
            </button>
          )}
        </div>
        <LyricsAside onOpenInfo={onOpenInfo} t={t} track={track} cover={cover} title={title} artist={artist} total={total} doc={doc} source={source} />
      </div>
      {waveOpen && !vizOpen && (
        <section className="lyrics-wave" aria-label={t("Wave")}>
          <div className="lyrics-wave-panel">
            <RealTimeWaveform audioRef={audioRef} track={player.selectedTrack} />
          </div>
        </section>
      )}
      <LyricsPlayerBar t={t} player={player} clock={clock} total={total} onClose={close} waveOpen={waveOpen} onToggleWave={() => setWaveOpen((v) => !v)} />
    </div>
  );
}

function PositionLabel({ clock, total }: { clock: LyricClock; total: number }) {
  const position = useSyncExternalStore(clock.subscribe, clock.read);
  return <> · {formatStamp(position)} / {formatStamp(total)}</>;
}
