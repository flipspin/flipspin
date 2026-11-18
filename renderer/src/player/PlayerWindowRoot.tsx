import type { AudioPlayerValue, PlayerTrack } from "../state/AudioPlayerContext";
import React, { useState, useEffect, useRef } from "react";
import { Play, X } from "lucide-react";
import Gameboy from "../ui/components/joypad";
import { useTranslation } from "react-i18next";

type WindowPlayerState = Pick<AudioPlayerValue, "selectedTrack" | "isPlaying" | "visualizationType" | "svgWaveformStyle" | "audioWaveformStyle" | "queue"> & { progress: number; duration: number };

function isPlayerTrack(value: unknown): value is PlayerTrack {
  if (!value || typeof value !== "object") return false;
  const track = value as Record<string, unknown>;
  return typeof track.path === "string"
    && (track.title === undefined || typeof track.title === "string")
    && (track.artist === undefined || typeof track.artist === "string")
    && (track.cover == null || typeof track.cover === "string")
    && (track.album == null || typeof track.album === "string" || (typeof track.album === "object"
      && (!("cover" in track.album) || track.album.cover == null || typeof track.album.cover === "string")
      && (!("album" in track.album) || track.album.album == null || typeof track.album.album === "string")));
}

function isPlayerState(value: unknown): value is Partial<WindowPlayerState> {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return ["visualizationType", "svgWaveformStyle", "audioWaveformStyle"].every(key => state[key] === undefined || typeof state[key] === "string")
    && ["progress", "duration"].every(key => state[key] === undefined || typeof state[key] === "number")
    && (state.isPlaying === undefined || typeof state.isPlaying === "boolean")
    && (state.selectedTrack == null || isPlayerTrack(state.selectedTrack))
    && (state.queue === undefined || (Array.isArray(state.queue) && state.queue.every(isPlayerTrack)));
}

const GAMEBOY_WIDTH = 280;
const GAMEBOY_HEIGHT = 405;

/**
 * Player window: Gameboy scales to fit when window is resized. Traffic lights on top (macOS).
 * Cola button opens the queue panel in this window.
 */
export default function PlayerWindowRoot() {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const updateScale = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const s = Math.min(w / GAMEBOY_WIDTH, h / GAMEBOY_HEIGHT, 2) || 1;
      setScale(s);
    };
    updateScale();
    window.addEventListener("resize", updateScale);
    return () => window.removeEventListener("resize", updateScale);
  }, []);

  const [state, setState] = useState<WindowPlayerState>({
    selectedTrack: null,
    isPlaying: false,
    progress: 0,
    duration: 0,
    visualizationType: "realtime",
    svgWaveformStyle: "area",
    audioWaveformStyle: "sine",
    queue: [],
  });
  const [showQueue, setShowQueue] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null);
  const queuePanelRef = useRef<HTMLDivElement>(null);

  // Hooks must run unconditionally, so compute availability as a flag and bail
  // out in the render body below (after every hook) rather than early-returning.
  const api = window.desktopAPI;
  const hasApi = !!(typeof api?.onPlayerState === "function" && typeof api?.sendPlayerAction === "function" && typeof api?.sendPlayerPlayToggle === "function");

  useEffect(() => {
    document.body.classList.add("player-window");
    return () => document.body.classList.remove("player-window");
  }, []);

  useEffect(() => {
    if (!hasApi || !api) return;
    const cb = (s: unknown) => { if (isPlayerState(s)) setState((prev) => ({ ...prev, ...s })); };
    const dispose = api.onPlayerState(cb);
    return () => dispose?.();
  }, [api, hasApi]);

  useEffect(() => {
    if (!hasApi || !api) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.code === "Space" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        api.sendPlayerPlayToggle();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [api, hasApi]);

  const { selectedTrack, visualizationType, svgWaveformStyle, audioWaveformStyle, queue = [] } = state;
  const album = typeof selectedTrack?.album === "object" ? selectedTrack.album : null;
  const coverUrl = album?.cover ?? (typeof selectedTrack?.cover === "string" ? selectedTrack.cover : null);
  const nowPlaying = selectedTrack;
  const hasQueue = (nowPlaying && nowPlaying.title) || queue.length > 0;

  const handleQueueDragOver = (e: React.DragEvent<HTMLDivElement>, idx: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropTargetIndex(idx);
  };
  const handleQueueDrop = (targetIndex: number) => {
    if (dragIndex === null) return;
    const insertIndex = dragIndex < targetIndex ? targetIndex - 1 : targetIndex;
    api?.sendPlayerAction({ type: "reorderQueue", from: dragIndex, to: insertIndex });
    setDragIndex(null);
    setDropTargetIndex(null);
  };
  const handleQueueDragEnd = () => {
    setDragIndex(null);
    setDropTargetIndex(null);
  };

  if (!hasApi || !api) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[var(--color-cream)] text-black">
        <p>{t("The player needs the desktop app.")}</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="player-window-root bg-[var(--color-cream)]"
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minWidth: GAMEBOY_WIDTH,
        minHeight: GAMEBOY_HEIGHT,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      data-tauri-drag-region="deep"
    >
      <div
        style={{
          width: GAMEBOY_WIDTH,
          height: GAMEBOY_HEIGHT,
          flexShrink: 0,
          transform: `scale(${scale})`,
          transformOrigin: "center center",
        }}
      >
        <Gameboy
        showKeyHints={false}
        coverUrl={coverUrl}
        disableKeyboard={false}
        onQueueClick={() => setShowQueue((prev) => !prev)}
        onLyricsClick={() => api.sendPlayerAction({ type: "openLyrics" })}
        onPlay={() => api.sendPlayerPlayToggle()}
        onNextTrack={() => api.sendPlayerAction({ type: "next" })}
        onPreviousTrack={() => api.sendPlayerAction({ type: "prev" })}
        visualizationType={visualizationType}
        waveformStyle={svgWaveformStyle}
        audioWaveformStyle={audioWaveformStyle}
        onVisualizationTypeChange={(v) => api.sendPlayerAction({ type: "setVisualizationType", value: v })}
        onWaveformStyleChange={(v) => api.sendPlayerAction({ type: "setSvgWaveformStyle", value: v })}
        onAudioWaveformStyleChange={(v) => api.sendPlayerAction({ type: "setAudioWaveformStyle", value: v })}
        />
      </div>
      {showQueue && (
        <>
          <button
            type="button"
            className="absolute inset-0 z-10 cursor-default bg-transparent"
            onClick={() => setShowQueue(false)}
            aria-label={t("Close queue")}
          />
          <div
            ref={queuePanelRef}
            className="cola-panel-neu absolute left-0 right-0 bottom-0 z-20 max-h-[70%] overflow-y-auto custom-scrollbar rounded-t-xl py-1 min-h-0 pointer-events-auto"
            data-tauri-drag-region="false"
            onClick={(e) => e.stopPropagation()}
          >
          {!hasQueue ? (
            <div className="player-bar-neu-text text-[11px] text-center py-4 px-3">
              {t("Queue is empty. Play something from the main window.")}
            </div>
          ) : (
            <>
              {nowPlaying && (
                <div className="cola-panel-section-now px-3 py-2 border-b border-gray-300/60 mx-1 rounded-t-panel">
                  <div className="text-[10px] font-bold uppercase tracking-wide player-bar-neu-text mb-0.5">{t("Now playing")}</div>
                  <div className="text-[12px] font-semibold truncate text-gray-800" title={nowPlaying.title}>{nowPlaying.title || t("Untitled")}</div>
                  <div className="truncate text-[10px] text-gray-600">{nowPlaying.artist || ""}</div>
                </div>
              )}
              {queue.length > 0 && (
                <div className="retro-song-table retro-song-table--embedded retro-song-table__body mx-2 my-2">
                  <div className="text-[10px] font-bold uppercase tracking-wide player-bar-neu-text mb-1 px-1">{t("Next in the queue")}</div>
                  {queue.map((track, idx) => (
                    <div
                      key={track.path || `${track.title || "track"}-${idx}`}
                      className="relative"
                    >
                      {dropTargetIndex === idx && (
                        <div
                          className="absolute left-0 right-0 top-0 z-10 h-0.5 w-full rounded-full bg-coral pointer-events-none"
                          style={{ minHeight: 2 }}
                          aria-hidden
                        />
                      )}
                      <div
                        draggable
                        onDragStart={() => setDragIndex(idx)}
                        onDragOver={(e) => handleQueueDragOver(e, idx)}
                        onDrop={() => handleQueueDrop(idx)}
                        onDragEnd={handleQueueDragEnd}
                        className={`retro-song-table__row flex items-center gap-2 px-2 py-1.5 text-[11px] cursor-move cola-panel-section ${dragIndex === idx ? "opacity-60" : ""}`}
                      >
                        <button
                          type="button"
                          onClick={() => api.sendPlayerAction({ type: "playQueueItemAt", index: idx })}
                          className="cola-panel-row-btn flex items-center justify-center w-7 h-7 shrink-0"
                          title={t("Play now")}
                        >
                          <Play size={16} strokeWidth={2.5} color="#1a1a1a" stroke="#1a1a1a" fill="#1a1a1a" className="ml-0.5 shrink-0" style={{ minWidth: 16, minHeight: 16 }} />
                        </button>
                        <div className="flex-1 min-w-0 text-gray-800">
                          <div className="truncate font-medium" title={`${track.title || t("Untitled")} — ${track.artist || ""}`}>
                            {track.title || t("Untitled")}
                          </div>
                          <div className="truncate text-[10px] text-gray-600">
                            {track.artist || ""} {typeof track.album === "object" && track.album?.album ? `· ${track.album.album}` : ""}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); api.sendPlayerAction({ type: "removeFromQueue", index: idx }); }}
                          className="cola-panel-remove-btn flex items-center justify-center w-7 h-7 shrink-0"
                          title={t("Remove from queue")}
                          aria-label={t("Remove from queue")}
                        >
                          <X size={16} strokeWidth={2.5} color="#ffffff" stroke="#ffffff" className="shrink-0" style={{ minWidth: 16, minHeight: 16 }} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          </div>
        </>
      )}
    </div>
  );
}
