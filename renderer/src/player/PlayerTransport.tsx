import { useSongMenu } from "../library/tracks/useSongMenu";
import { useTrackPresence } from "../library/trackPresence";
import type { openTrackInfo } from "../library/tracks/trackInfoStore";
import type { AnalysisTrack } from "../analysis/display";
import type { PlayerTrack, AudioPlayerValue } from "../state/AudioPlayerContext";
import { AnalysisValue } from "../analysis/AnalysisValue";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { SlidersHorizontal, Volume2, SkipBack, SkipForward, Play, Pause, Shuffle, ListMusic, MicVocal, Orbit, Trash2, X } from "lucide-react";
import "./player-transport.css";
import { lyricsKeyOf, loadLyrics, openLyricsOrAdd, useHasLyrics } from "../lyrics/lyricsStore";
import { openViz } from "../viz/vizStore";
import { useAudioPlayer, useAudioProgress } from "@state/AudioPlayerContext";
import { useAudioAnalyzer } from "@state/AudioAnalyzerContext";
import { formatTime } from "@lib/formatting";
import { buildCoverImageUrl, parseTrackPath } from "@lib/api";
import CoverTile from "../ui/components/CoverTile";
import { openLibraryAlbum, openLibraryArtist } from "../browse/navigationStore";
import { primaryArtist } from "../albums/artistMatch";
import TrackContextMenu, { menuPointFrom } from "../albums/TrackContextMenu";
import { useAddToPlaylistMenu } from "../library/tracks/useAddToPlaylistMenu";
import LyricsModal from "../lyrics/LyricsModal";
import { useStatus } from "../state/useStatus";
import QueueList from "./QueueList";
import { useTranslation } from "react-i18next";
import { Missing } from "../ui/react/components/Missing";
import { missingWord } from "../ui/react/components/missingWords";
import { failureReason } from './notices';
import { useVolume, setVolume } from './volumeStore';
import { LoaderCircle } from 'lucide-react';

// ── design tokens (match the "Mesa" design transport) ─────────────────
const LINE = "var(--line)";
const CARD = "var(--panel)";
const CORAL = "var(--coral)";
const TEAL = "var(--teal)";
const YELLOW = "var(--yellow)";
const BG = "var(--canvas)";

// Neo-brutalist square control (34×34). minHeight/padding/background are inline so
// they beat the unlayered global `button {}` rule (coral bg + 36px min-height).
const sq = (active: boolean): React.CSSProperties => ({
  width: 34, height: 34, minHeight: 0, padding: 0,
  display: "grid", placeItems: "center",
  border: `2px solid ${LINE}`, borderRadius: 7,
  background: active ? CORAL : CARD,
  boxShadow: `2px 2px 0 0 ${LINE}`, cursor: "pointer",
});
const playBtnStyle: React.CSSProperties = {
  width: 48, height: 48, minHeight: 0, padding: 0,
  display: "grid", placeItems: "center",
  border: `2px solid ${LINE}`, borderRadius: 9,
  background: CORAL, boxShadow: `3px 3px 0 0 ${LINE}`, cursor: "pointer",
};
// The queue button is yellow when closed and coral when the panel is open; its
// own accent, distinct from the cream control buttons. The count sits on its
// top-right corner as a small ink bubble, an exponent on the icon.
const queueBadge: React.CSSProperties = {
  position: "absolute", top: -9, right: -9,
  minWidth: 18, height: 18, padding: "0 5px", boxSizing: "border-box",
  display: "grid", placeItems: "center",
  fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, lineHeight: 1,
  background: "#151515", color: "#FFFEF7",
  border: `2px solid ${CARD}`, borderRadius: 999,
  pointerEvents: "none",
};

/**
 * Cross-fades a slot when `swapKey` changes (a new song in the player bar):
 * the previous content stays for one exit, stacked in the same box and
 * absolutely placed so the layout never shifts, fading out on the exit role
 * while the new content comes in; then it is dropped. `leavingOnTop` puts the
 * old layer above the new one (an opaque cover would otherwise hide it at once).
 * Reduced motion: the global rule shortens the animations, and animationend
 * still clears the old layer.
 */
function Crossfade({ swapKey, children, style, enterClassName = "", leavingOnTop = false }: { swapKey: string; children: React.ReactNode; style?: React.CSSProperties; enterClassName?: string; leavingOnTop?: boolean }) {
  const last = useRef({ key: swapKey, node: children });
  const [leaving, setLeaving] = useState<{ key: string; node: React.ReactNode } | null>(null);
  if (last.current.key !== swapKey) {
    const old = last.current;
    last.current = { key: swapKey, node: children };
    setLeaving(old);
  } else {
    last.current.node = children;
  }
  const out = leaving && (
    <div key={`${leaving.key}·out`} className="np-exit" aria-hidden
      style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: leavingOnTop ? 1 : 0 }}
      onAnimationEnd={() => setLeaving(null)}>
      {leaving.node}
    </div>
  );
  return (
    <div style={{ position: "relative", ...style }}>
      {!leavingOnTop && out}
      <div key={swapKey} className={enterClassName} style={{ position: "relative", height: "100%", minWidth: 0 }}>{children}</div>
      {leavingOnTop && out}
    </div>
  );
}

// A track's cover, however it reached the queue. `album.cover` is only set
// when the caller decorated the track; and the album list is fetched with
// `covers=false`, so it usually is not. The path's directory is always there
// and is what the media route keys on; CoverTile falls back to initials on 404.
function coverOf(track: PlayerTrack | null) {
  if (!track) return null;
  const albumObj = track.album && typeof track.album === "object" ? track.album : null;
  if (albumObj?.cover) return albumObj.cover;
  if (track.albumCover) return track.albumCover;
  const { albumName } = parseTrackPath(track.path);
  return albumName ? buildCoverImageUrl(albumName) : null;
}
function labelOf(track: PlayerTrack | null) {
  const albumObj = track?.album && typeof track.album === "object" ? track.album : null;
  return track?.title || albumObj?.album || "";
}
const ellipsis: React.CSSProperties = { whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };

// A horizontal click+drag track, reused for the seek bar and the volume bar.
function DragTrack({ value, onChange, fill, disabled, width, ariaLabel }: { value: number; onChange: (value: number) => void; fill: string; disabled?: boolean; width?: number; ariaLabel: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const frac = (clientX: number) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r || r.width === 0) return value;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    onChange(frac(e.clientX));
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => { if (dragging.current) onChange(frac(e.clientX)); };
  const up = (e: React.PointerEvent<HTMLDivElement>) => { dragging.current = false; e.currentTarget.releasePointerCapture?.(e.pointerId); };
  return (
    <div
      ref={ref}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      role="slider"
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round((value || 0) * 100)}
      aria-disabled={disabled || undefined}
      style={{
        flex: width ? "none" : 1,
        width: width || undefined,
        height: 10,
        background: BG,
        border: `2px solid ${LINE}`,
        borderRadius: 999,
        overflow: "hidden",
        cursor: disabled ? "default" : "pointer",
        touchAction: "none",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <div style={{ height: "100%", width: `${Math.max(0, Math.min(1, value || 0)) * 100}%`, background: fill }} />
    </div>
  );
}

/** Use AudioPlayerContext for playback intent; this component owns only transport controls. */
/** Isolate playhead updates so position ticks do not rerender the transport and queue. */
function SeekBar({ audioRef }: Pick<AudioPlayerValue, "audioRef">) {
  const { t } = useTranslation();
  const { progress, setProgress, duration } = useAudioProgress();

  const barMax = Math.max(duration || 0, 0.01);
  const barValue = Math.min(progress || 0, duration || 0);
  const leftTime = formatTime(progress);
  const rightTime = formatTime(duration || 0);

  const seek = (frac: number) => {
    const el = audioRef?.current;
    if (!el) return;
    const secs = frac * (duration || 0);
    el.currentTime = secs;
    setProgress(secs);
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", maxWidth: 560 }}>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-3)", width: 38, textAlign: "right" }}>{leftTime}</span>
      <DragTrack value={barMax ? barValue / barMax : 0} onChange={seek} fill="var(--dm-ink, #151515)" disabled={false} ariaLabel={t("Position")} />
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--ink-3)", width: 38 }}>{rightTime}</span>
    </div>
  );
}

export default function PlayerTransport({ onOpenInfo, onToggleStems, stemsOpen = false }: { onOpenInfo?: typeof openTrackInfo; onToggleStems?: () => void; stemsOpen?: boolean } = {}) {
  const {
    audioRef,
    isPlaying,
    playerState,
    failureCause,
    setIsPlaying,
    selectedTrack,
    waitingForNest,
    nowPlaying,
    shuffleEnabled,
    toggleShuffle,
    goNext,
    goPrevious,
    queue = [],
    reorderQueue,
    removeFromQueue,
    playQueueItemAt,
    clearQueue,
    removeDeletedSongs,
  } = useAudioPlayer();
  const present = useTrackPresence();
  const deletedCount = queue.filter(track => !present(track)).length;
  const { t } = useTranslation();

  const { setOutputVolume } = (useAudioAnalyzer() as { setOutputVolume?: (volume: number) => void } | null) || {};

  // Right-click on the cover: the playing song's menu; the Library row's
  // actions that make sense for a song already playing.
  const { showSuccess, showError } = useStatus();
  const playlistMenu = useAddToPlaylistMenu({ showSuccess, showError });
  const [ctx, setCtx] = useState({ open: false, x: 0, y: 0 });
  const [lyricsTrack, setLyricsTrack] = useState<PlayerTrack | null>(null);
  const closeCtx = useCallback(() => setCtx((c) => ({ ...c, open: false })), []);
  const openCtx = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    if (!selectedTrack) return;
    setCtx({ open: true, ...menuPointFrom(e) });
    playlistMenu.refresh();
  };
  const songMenu = useSongMenu(selectedTrack ? [selectedTrack] : [], { showSuccess, showError });
  const ctxItems = selectedTrack ? songMenu.build({
    omit: new Set(["play", "playNext", "queue"]),
    playlistSubmenu: playlistMenu.submenu([selectedTrack]),
    onOpenLyrics: () => setLyricsTrack(selectedTrack),
  }) : [];

  const volume = useVolume();
  const [showQueue, setShowQueue] = useState(false);
  const queuePanelRef = useRef<HTMLDivElement>(null);
  const queueScrollerRef = useRef<HTMLDivElement>(null);

  // Volume is the graph's output gain, exposed by the engine port.
  useEffect(() => {
    const engine = audioRef?.current;
    if (engine) engine.volume = volume;
    else setOutputVolume?.(volume);
  }, [audioRef, volume, setOutputVolume]);
  useEffect(() => {
    const engine = audioRef?.current;
    if (!engine) return;
    const changed = () => setVolume(engine.volume);
    engine.addEventListener('volumechange', changed);
    return () => engine.removeEventListener('volumechange', changed);
  }, [audioRef]);

  // Open the queue from anywhere (e.g. album/playlist "Cola" buttons fire this).
  useEffect(() => {
    const handler = () => setShowQueue(true);
    window.addEventListener("krobi-show-queue", handler);
    return () => window.removeEventListener("krobi-show-queue", handler);
  }, []);

  useEffect(() => {
    if (!showQueue) return;
    const onDown = (e: MouseEvent) => {
      if (queuePanelRef.current && !queuePanelRef.current.contains(e.target as Node | null)) setShowQueue(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [showQueue]);

  // Nothing loaded: no title at all (an idle player is not a missing value).
  const title = selectedTrack ? selectedTrack.title || missingWord("noTitle") : "";
  const artist = selectedTrack?.artist || "";
  const coverUrl = waitingForNest ? null : coverOf(selectedTrack);
  const togglePlay = () => {
    if (waitingForNest || (!audioRef?.current && !selectedTrack)) return;
    setIsPlaying((p) => !p);
  };
  const hasNow = nowPlaying && nowPlaying.title;
  // Whether the playing song has a lyric, for the transport glyph. Asked once
  // per song; the store remembers the answer.
  const nowRel = lyricsKeyOf(nowPlaying);
  const hasLyrics = useHasLyrics(nowRel);
  useEffect(() => {
    if (nowRel) void loadLyrics(nowRel).catch(() => {});
  }, [nowRel]);
  const badge = {
    fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700,
    padding: "1px 6px", border: `1.5px solid ${LINE}`, borderRadius: 4, background: BG,
  };

  return (
    <div className="player-transport" style={{ flex: "none", position: "relative" }}>
      {/* coral accent strip */}
      <div style={{ height: 5, background: CORAL, borderBottom: `2px solid ${LINE}` }} />

      <div style={{ minHeight: 84, background: CARD, display: "flex", alignItems: "center", padding: "0 20px", gap: 18, flexWrap: "wrap" }}>
        {/* now playing */}
        <div style={{ display: "flex", alignItems: "center", gap: 13, width: 300, flex: "1 1 220px", minWidth: 0 }}>
          {}
          {/* The cover opens the playing song's album. */}
          <button
            type="button"
            onClick={() => selectedTrack && openLibraryAlbum(selectedTrack)}
            onContextMenu={openCtx}
            disabled={!selectedTrack}
            title={selectedTrack ? t("Open album") : undefined}
            aria-label={t("Open album")}
            style={{ width: 64, height: 64, minHeight: 0, padding: 0, flex: "none", borderRadius: 6, border: `1px solid ${LINE}`, boxShadow: `2px 2px 0 0 ${LINE}`, display: "grid", placeItems: "center", overflow: "hidden", background: "transparent", cursor: selectedTrack ? "pointer" : "default" }}
          >
            {/* A new song: the old cover fades out on top while the new one
                arrives with its image's own load fade (CoverTile). */}
            <Crossfade swapKey={selectedTrack?.path ?? "none"} leavingOnTop style={{ width: "100%", height: "100%" }}>
              <CoverTile src={coverUrl} label={labelOf(selectedTrack)} fontSize="16px" style={{ width: "100%", height: "100%" }} />
            </Crossfade>
          </button>
          <Crossfade swapKey={selectedTrack?.path ?? "none"} enterClassName="np-enter" style={{ minWidth: 0 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14.5, ...ellipsis }} title={title}>{title}</div>
            {waitingForNest && <Missing kind="connecting" reason={t("Waiting for your nest")} />}
            {artist && (
              <div style={{ fontSize: 12.5, color: "var(--ink-3)", ...ellipsis }}>
                <span role="link" tabIndex={0} className="song-row__album-link" onClick={() => openLibraryArtist(primaryArtist(artist))} onKeyDown={(e) => e.key === "Enter" && openLibraryArtist(primaryArtist(artist))} title={t("Go to artist")}>
                  {artist}
                </span>
              </div>
            )}
            {selectedTrack && (
              <div style={{ display: "flex", gap: 6, marginTop: 3 }}>
                <span style={badge}><AnalysisValue track={selectedTrack as PlayerTrack & AnalysisTrack} field="bpm" unit onOpenInfo={onOpenInfo ? () => onOpenInfo(selectedTrack as Parameters<typeof openTrackInfo>[0]) : undefined} /></span>
                <span style={badge}><AnalysisValue track={selectedTrack as PlayerTrack & AnalysisTrack} field="key" onOpenInfo={onOpenInfo ? () => onOpenInfo(selectedTrack as Parameters<typeof openTrackInfo>[0]) : undefined} /></span>
              </div>
            )}
          </div>
          </Crossfade>
        </div>

        {/* controls + seek */}
        <div style={{ flex: "1 1 320px", minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 7 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <button type="button" onClick={toggleShuffle} title={shuffleEnabled ? t("Shuffle on") : t("Shuffle")} aria-pressed={shuffleEnabled} style={sq(shuffleEnabled)}>
              <Shuffle size={18} strokeWidth={2.5} color={shuffleEnabled ? "#151515" : "var(--dm-ink, #151515)"} />
            </button>
            <button type="button" onClick={() => goPrevious?.()} title={t("Previous")} style={sq(false)}>
              <SkipBack size={19} strokeWidth={2.5} color="var(--dm-ink, #151515)" />
            </button>
            <button type="button" onClick={togglePlay} disabled={waitingForNest}
              aria-label={waitingForNest ? t("Waiting for your nest") : playerState === 'failed' ? t("Retry") : t("Play / pause")}
              title={waitingForNest ? t("Waiting for your nest") : playerState === 'retrying' ? t("Reconnecting…") : playerState === 'failed' ? failureReason(failureCause) : t("Play / pause")}
              style={playerState === 'failed' ? { ...playBtnStyle, width: 'auto', padding: '0 8px' } : playBtnStyle}>
              {playerState === 'failed' ? t("Retry") : playerState === 'buffering' || playerState === 'retrying' ? <LoaderCircle size={22} className="animate-spin" aria-hidden /> : isPlaying
                ? <Pause size={22} strokeWidth={2.5} fill="#151515" color="#151515" />
                : <Play size={22} strokeWidth={2.5} fill="#151515" color="#151515" style={{ marginLeft: 2 }} />}
            </button>
            <button type="button" onClick={() => goNext?.()} title={t("Next")} style={sq(false)}>
              <SkipForward size={19} strokeWidth={2.5} color="var(--dm-ink, #151515)" />
            </button>
            {/* Set an explicit quiet style so the global button rule cannot give an absent lyric an active appearance. */}
            <button type="button" onClick={() => { if (nowRel) void openLyricsOrAdd(nowRel); }} disabled={!nowRel} title={`${hasLyrics ? t("Lyrics") : t("Add lyrics…")} (L)`} aria-label={hasLyrics ? t("Lyrics") : t("Add lyrics…")} style={{ ...sq(hasLyrics), opacity: nowRel ? 1 : 0.5 }}>
              <MicVocal size={18} strokeWidth={2.5} color={hasLyrics ? "#151515" : "var(--dm-ink, #151515)"} />
            </button>
          </div>
          <SeekBar audioRef={audioRef} />
        </div>

        {/* volume + queue */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, width: 300, flex: "1 1 220px", justifyContent: "flex-end", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <Volume2 size={18} strokeWidth={2.5} color="var(--dm-ink, #151515)" />
            <DragTrack value={volume} onChange={setVolume} fill={TEAL} width={88} ariaLabel={t("Volume")} />
          </div>
          {/* The full-screen visualizer: Ondas, over whatever is playing. */}
          <button type="button" onClick={openViz} title={`${t("Visualizer")} (D)`} aria-label={t("Visualizer")} style={sq(false)}>
            <Orbit size={18} strokeWidth={2.5} color="var(--dm-ink, #151515)" />
          </button>
          <button type="button" onClick={onToggleStems} title={t('Stems')} aria-label={t('Stems')} aria-pressed={stemsOpen} style={sq(stemsOpen)}><SlidersHorizontal size={18} strokeWidth={2.5} color="var(--dm-ink, #151515)" /></button>
          {/* The queue lives only here, beside the volume: a yellow square with
              the count riding its top-right corner like an exponent. The bubble
              spills past the button's edge, hence `overflow: visible` and the
              margin that keeps it inside the bar's padding. */}
          <button type="button" onClick={() => setShowQueue((v) => !v)} title={t("Queue")} aria-label={t("Queue")} aria-pressed={showQueue} style={{ ...sq(showQueue), background: showQueue ? CORAL : YELLOW, position: "relative", overflow: "visible", marginRight: 6 }}>
            <ListMusic size={18} strokeWidth={2.5} color="#151515" />
            {queue.length > 0 && (
              <span aria-hidden="true" style={queueBadge}>{queue.length}</span>
            )}
          </button>
        </div>
      </div>

      <TrackContextMenu
        open={ctx.open}
        x={ctx.x}
        y={ctx.y}
        title={selectedTrack?.title}
        artist={selectedTrack?.artist || ""}
        items={ctxItems}
        onClose={closeCtx}
      />
      <LyricsModal
        open={!!lyricsTrack}
        relPath={lyricsKeyOf(lyricsTrack)}
        track={lyricsTrack}
        onClose={() => setLyricsTrack(null)}
      />

      {/* ── Cola panel (design styling, all existing queue features kept) ──────── */}
      {showQueue && (
        <div
          ref={queuePanelRef}
          style={{
            position: "absolute", bottom: "calc(100% + 8px)", right: 20, zIndex: 50,
            width: 360, maxHeight: "70vh", display: "flex", flexDirection: "column",
            background: CARD, border: `2px solid ${LINE}`, borderRadius: 12,
            boxShadow: `5px 5px 0 0 ${LINE}`, overflow: "hidden",
          }}
        >
          {/* header (yellow) */}
          <div style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 12px 0 15px", height: 52, borderBottom: `2px solid ${LINE}`, background: "var(--yellow)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <h3 style={{ margin: 0, fontFamily: "var(--font-pixel)", fontWeight: 700, fontSize: 18, color: "#151515" }}>{t("Queue")}</h3>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700, background: "#151515", color: "#FFFEF7", borderRadius: 5, padding: "2px 7px" }}>{queue.length}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button type="button" className="qhead-icon" onClick={toggleShuffle} title={t("Shuffle")} aria-label={t("Shuffle")} aria-pressed={shuffleEnabled}>
                <Shuffle size={17} strokeWidth={2.5} />
              </button>
              <button type="button" className="qhead-icon" onClick={clearQueue} disabled={queue.length === 0} title={t("Clear queue")} aria-label={t("Clear queue")}>
                <Trash2 size={17} strokeWidth={2.5} />
              </button>
              <button type="button" className="qhead-icon" onClick={() => setShowQueue(false)} title={t("Close")} aria-label={t("Close")}>
                <X size={19} strokeWidth={2.75} />
              </button>
            </div>
          </div>

          {deletedCount > 0 && (
            <button type="button" className="k-btn k-btn--text" onClick={removeDeletedSongs}>
              <Trash2 size={17} aria-hidden />
              <span>{t("Remove deleted songs ({{n}})", { n: deletedCount })}</span>
            </button>
          )}

          {/* now playing; pinned */}
          {hasNow && (
            <div style={{ flex: "none", padding: "11px 14px", borderBottom: `1px solid var(--line-soft)` }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, fontFamily: "var(--font-pixel)", fontSize: 11, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--ink-3)", marginBottom: 8 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: CORAL, border: `1.5px solid ${LINE}` }} />
                {t("Now playing_sounding")}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <CoverTile src={waitingForNest ? null : coverOf(nowPlaying)} label={labelOf(nowPlaying)} fontSize="13px" style={{ width: 40, height: 40, flex: "none", borderRadius: 7, border: `2px solid ${LINE}`, boxShadow: `2px 2px 0 0 ${LINE}` }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: "var(--dm-ink, #151515)", ...ellipsis }} title={nowPlaying.title}>{nowPlaying.title || t("Untitled")}</div>
                  <div style={{ fontSize: 12, color: "var(--ink-3)", ...ellipsis }}>{nowPlaying.artist || ""}</div>
                </div>
              </div>
            </div>
          )}

          {/* upcoming; the only scrolling region */}
          <div ref={queueScrollerRef} className="custom-scrollbar" style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "8px 10px 12px" }}>
            {queue.length === 0 ? (
              <div style={{ fontSize: 12.5, color: "var(--ink-3)", textAlign: "center", padding: "22px 8px" }}>
                {hasNow ? t("No more songs in the queue.") : t("Queue is empty. Play something from albums or playlists.")}
              </div>
            ) : (
              <div className="retro-song-table retro-song-table--embedded retro-song-table__body">
                <div style={{ fontFamily: "var(--font-pixel)", fontSize: 10.5, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--ink-3)", margin: "2px 4px 8px" }}>{t("Next in the queue")}</div>
                <QueueList
                  queue={queue}
                  scrollerRef={queueScrollerRef}
                  coverOf={coverOf}
                  labelOf={labelOf}
                  onPlay={playQueueItemAt}
                  onRemove={removeFromQueue}
                  onReorder={reorderQueue}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
