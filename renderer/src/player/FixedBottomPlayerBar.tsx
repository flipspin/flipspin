import type { openTrackInfo } from "../library/tracks/trackInfoStore";
import React, { useState, useCallback, useEffect, useRef } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useAudioPlayer } from "@state/AudioPlayerContext";
import RealTimeWaveform from "../viz/RealTimeWaveform";
import PlayerTransport from "./PlayerTransport";
import { useLyricsOverlayRelPath } from "../lyrics/lyricsStore";
import { useVizOpen } from "../viz/vizStore";
import { useTranslation } from "react-i18next";

import StemsPage from '../stems/StemsPage';
import { msg } from '../i18n';
import { stemTrack, trackKey } from '../stems/stemApi';
import { ToastProvider } from '../settings/parts';
import '../stems/stems.css';

const PAGE_KEY = 'krobi.bottomBarDrawerPage';
const PAGES = ['waveform', 'stems', 'jog'] as const;
const PAGE_LABELS = { waveform: msg("Wave"), stems: msg('Stems'), jog: msg('Jog') };
// Keep writing the existing storage values so other windows and older builds can read them.
const SAVED_PAGES = { waveform: 'Onda', stems: 'Stems', jog: 'Jog' };
function loadPage() {
  try {
    const saved = localStorage.getItem(PAGE_KEY);
    return PAGES.find(id => SAVED_PAGES[id] === saved || id === saved) ?? 'waveform';
  } catch { return 'waveform'; }
}
const STORAGE_KEY = "krobi.bottomBarHeight";
const DRAWER_KEY = "krobi.bottomBarDrawerOpen";
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 320;
const DEFAULT_HEIGHT = 128;

function loadStoredHeight() {
  try {
    const v = parseInt(localStorage.getItem(STORAGE_KEY) ?? "", 10);
    if (Number.isFinite(v) && v >= MIN_HEIGHT && v <= MAX_HEIGHT) return v;
  } catch { /* localStorage unavailable — fall back to default */ }
  return DEFAULT_HEIGHT;
}

function loadDrawerOpen() {
  try {
    const v = localStorage.getItem(DRAWER_KEY);
    return v === null ? true : v === "1";
  } catch { /* localStorage unavailable — default open */ }
  return true;
}

/**
 * Fixed bottom bar (app shell): the "Mesa" transport, always visible, with a
 * collapsible drawer above it with Waveform, Stems and Jog pages. Renders across
 * all pages so playback controls remain reachable. The drawer height is
 * draggable from the slim handle at its top while open.
 */
export default function FixedBottomPlayerBar({ onOpenInfo }: { onOpenInfo?: typeof openTrackInfo } = {}) {
  const { audioRef, selectedTrack, nowPlaying } = useAudioPlayer();
  const { t } = useTranslation();
  // Unmount the covered waveform while lyrics or the visualizer reads the shared analyser
  // to avoid rendering an invisible canvas.
  const vizOpen = useVizOpen();
  const covered = Boolean(useLyricsOverlayRelPath()) || vizOpen;

  const [panelHeight, setPanelHeight] = useState(loadStoredHeight);
  const [page, setPage] = useState(loadPage);
  const [drawerOpen, setDrawerOpen] = useState(loadDrawerOpen);
  const dragRef = useRef({ active: false, startY: 0, startHeight: 0 });

  const handleResizeMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = panelHeight;
    dragRef.current = { active: true, startY, startHeight };

    const onMove = (e: MouseEvent) => {
      const delta = dragRef.current.startY - e.clientY;
      const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + delta));
      setPanelHeight(next);
    };
    const onUp = () => {
      dragRef.current.active = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [panelHeight]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, String(panelHeight)); } catch { /* ignore persistence errors */ }
  }, [panelHeight]);

  useEffect(() => {
    try { localStorage.setItem(DRAWER_KEY, drawerOpen ? "1" : "0"); } catch { /* ignore persistence errors */ }
  }, [drawerOpen]);

  useEffect(() => { try { localStorage.setItem(PAGE_KEY, SAVED_PAGES[page]); } catch { /* ignore */ } }, [page]);
  const currentSong = stemTrack(nowPlaying);
  const toggleStems = () => { setDrawerOpen(!(drawerOpen && page === 'stems')); setPage('stems'); };

  return (
    <ToastProvider className="stems-drawer-toast"><div className="shrink-0 w-full flex flex-col border-t-2 border-black relative">
      {/* The drawer floats over the page instead of taking height from it:
          anchored to the bar's top edge (`bottom: 100%`) and growing upward, so
          opening it or dragging its height never reflows the page underneath.
          Closed, the wrapper is empty and zero-high and only the handle shows. */}
      <div className="player-drawer-layer absolute left-0 right-0 z-30" style={{ bottom: "100%" }}>
      {/* The top-edge tab follows the persisted drawer page. */}
      <button
        type="button"
        onClick={() => setDrawerOpen((o) => !o)}
        aria-label={t(PAGE_LABELS[page])}
        aria-expanded={drawerOpen}
        style={{
          // Rest the tab on the bar's top border; overlapping the bar would cover the play button.
          position: "absolute", left: "50%", top: -24, transform: "translateX(-50%)", zIndex: 5,
          display: "flex", alignItems: "center", gap: 7, height: 26, minHeight: 0, padding: "0 14px",
          fontFamily: "var(--font-pixel)", fontSize: 12, letterSpacing: ".05em", textTransform: "uppercase",
          color: "var(--dm-ink, #151515)",
          background: "var(--panel)",
          border: "2px solid var(--dm-line, #151515)", borderRadius: "8px 8px 0 0", borderBottom: "none",
          boxShadow: "3px -2px 0 0 #15151522", cursor: "pointer",
        }}
      >
        {drawerOpen ? <ChevronDown size={14} strokeWidth={3} aria-hidden /> : <ChevronUp size={14} strokeWidth={3} aria-hidden />} {t(PAGE_LABELS[page])}
      </button>

      {drawerOpen && (
        <div className="border-t-2 border-black pb-1" style={{ background: "var(--canvas)" }}>
          <div
            role="separator"
            aria-label={t("Resize the wave")}
            className="w-full flex items-center justify-center cursor-ns-resize select-none flex-shrink-0 py-1"
            style={{ minHeight: 10 }}
            onMouseDown={handleResizeMouseDown}
          >
            <div className="w-full bg-coral/50 hover:bg-coral transition-colors rounded-full" style={{ height: 3 }} aria-hidden />
          </div>
          {/* Use one frame around the waveform to avoid nested borders. */}
          <div
            className="stems-drawer waveform-panel shrink-0 mx-2 bg-panel border-2 border-black rounded-xl overflow-hidden"
            style={{ height: page === "waveform" ? panelHeight : Math.max(176, panelHeight) }}
          >
            <div className="mx-pager">
            <button type="button" className="mx-pager-step" title={t("Previous page")} aria-label={t("Previous page")} disabled={PAGES.indexOf(page) === 0} onClick={() => setPage(PAGES[PAGES.indexOf(page) - 1])}><ChevronUp size={14} strokeWidth={2.5} aria-hidden /></button>
            <div className="mx-pager-dots" role="tablist" aria-label={t("Drawer pages")} aria-orientation="vertical">
              {PAGES.map((name, index) => <button key={name} id={`drawer-tab-${name}`} type="button" role="tab" aria-selected={page === name} aria-controls={page === name ? `drawer-panel-${page}` : undefined} tabIndex={page === name ? 0 : -1} className={page === name ? 'is-on' : ''} title={t(PAGE_LABELS[name])} aria-label={t(PAGE_LABELS[name])} onClick={() => setPage(name)} onKeyDown={e => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
                e.preventDefault();
                const next = e.key === 'Home' ? 0 : e.key === 'End' ? 2 : (index + (e.key === 'ArrowDown' ? 1 : 2)) % 3;
                setPage(PAGES[next]); document.getElementById(`drawer-tab-${PAGES[next]}`)?.focus();
              }}><i aria-hidden /><span className="mx-pager-label">{t(PAGE_LABELS[name])}</span></button>)}
            </div>
            <button type="button" className="mx-pager-step" title={t("Next page")} aria-label={t("Next page")} disabled={PAGES.indexOf(page) === PAGES.length - 1} onClick={() => setPage(PAGES[PAGES.indexOf(page) + 1])}><ChevronDown size={14} strokeWidth={2.5} aria-hidden /></button>
            </div>
            <div role="tabpanel" id={`drawer-panel-${page}`} aria-labelledby={`drawer-tab-${page}`} style={{ minWidth: 0, height: '100%' }}>
              {page === 'waveform' && !covered && <RealTimeWaveform audioRef={audioRef} track={selectedTrack} />}
              {page === 'stems' && <StemsPage key={currentSong ? trackKey(currentSong) : "none"} track={currentSong} visible={!covered} />}
              {page === 'jog' && <div className="mx-jog" style={{ height: '100%' }}>{t("Coming soon")}</div>}
            </div>
          </div>
        </div>
      )}
      </div>

      {/* Always-visible transport (design "Mesa" player) */}
      <PlayerTransport onOpenInfo={onOpenInfo} onToggleStems={toggleStems} stemsOpen={drawerOpen && page === "stems"} />
    </div></ToastProvider>
  );
}
