/** Unmount the covered waveform drawer while this overlay reads the shared analyser
 * so only one visualization loop runs. Keep transport controls open while they are in use. */
import type { PlaybackPort } from '../player/engine/PlaybackPort';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Lock, LockOpen, Pause, Play, Rotate3d, RotateCcw, Shuffle, SkipBack, SkipForward, SlidersHorizontal, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { msg } from "../i18n";
import { useAudioPlayer, useAudioProgress } from "@state/AudioPlayerContext";
import { useAudioAnalyzer } from "@state/AudioAnalyzerContext";
import { formatTime } from "@lib/formatting";
import { Track } from "../lyrics/LyricsOverlay";
import krobiMark from "../assets/krobi-mark.png";
import { DEFAULT_PARAMS, DEFAULT_TILT, MAX_RINGS, createWaveRings, type Params, type WaveRings } from "./waveRings";
import { closeViz, useVizOpen } from "./vizStore";

// The rings want an analyser almost unsmoothed so a beat lands as a sharp
// bright ring; the shared one defaults to 0.8 for the calm bottom-bar scope.
const SMOOTHING = 0.1;
/** Seconds of playback, hands off, before the pill folds back into its disc. */
const FOLD_AFTER_S = 4;
/** Idle time before the cursor disappears over the rings. */
const CURSOR_HIDE_MS = 2500;
/** The readout's refresh; the numbers are read straight from the engine. */
const READOUT_MS = 100;
const MOTION_KEY = "krobi.vizMotion";
const LOCK_KEY = "krobi.vizLock";
// Version the settings key because older ring controls use incompatible scales.
const PARAMS_KEY = "krobi.vizParams.v2";
/** The tilt the mouse last left the rings at; not a knob, but kept like one. */
const TILT_KEY = "krobi.vizTilt.v2";

function readTilt(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(TILT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { x?: unknown; y?: unknown };
    return typeof v.x === "number" && typeof v.y === "number" ? { x: v.x, y: v.y } : null;
  } catch {
    return null;
  }
}

function readMotion(): boolean {
  try {
    return localStorage.getItem(MOTION_KEY) !== "0";
  } catch {
    return true;
  }
}

function readPref(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function readParams(): Params {
  try {
    const raw = localStorage.getItem(PARAMS_KEY);
    const saved = raw ? (JSON.parse(raw) as Partial<Params>) : {};
    const out = { ...DEFAULT_PARAMS };
    for (const k of Object.keys(DEFAULT_PARAMS) as (keyof Params)[]) {
      const v = saved[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return { ...DEFAULT_PARAMS };
  }
}

/** The knobs, in the order the panel shows them. `show` is the label's number. */
interface Knob {
  key: keyof Params;
  label: string;
  min: number;
  max: number;
  step: number;
  show: (v: number) => string;
}
const KNOBS: Knob[] = [
  { key: "radius", label: msg("Hole"), min: 2, max: 150, step: 1, show: (v) => String(Math.round(v)) },
  { key: "size", label: msg("Size"), min: 60, max: 600, step: 5, show: (v) => String(Math.round(v)) },
  { key: "rings", label: msg("Rings"), min: 10, max: MAX_RINGS, step: 1, show: (v) => String(Math.round(v)) },
  { key: "band", label: msg("Band"), min: 32, max: 512, step: 16, show: (v) => `${((v * 22.05) / 512).toFixed(1)} kHz` }, // at 44.1 kHz
  { key: "lift", label: msg("Sensitivity"), min: 0, max: 8, step: 0.1, show: (v) => v.toFixed(1) },
  { key: "wave", label: msg("Wave"), min: 0.2, max: 3, step: 0.05, show: (v) => `×${v.toFixed(2)}` },
  { key: "distance", label: msg("Distance"), min: 80, max: 2000, step: 10, show: (v) => String(Math.round(v)) },
  { key: "drift", label: msg("Yaw"), min: 0, max: 0.012, step: 0.0002, show: (v) => `${((v * 60 * 180) / Math.PI).toFixed(1)}°/s` },
  { key: "wander", label: msg("Wander"), min: 0, max: 1.5, step: 0.01, show: (v) => `${Math.round((v * 180) / Math.PI)}°` },
  { key: "hueSpeed", label: msg("Colour"), min: 0, max: 0.03, step: 0.0005, show: (v) => (v * 1000).toFixed(1) },
  { key: "curve", label: msg("Curvature"), min: -1, max: 1, step: 0.02, show: (v) => (Math.abs(v) < 0.01 ? "0" : `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(2)}`) }, // − dish · + dome
];

export default function VizOverlay() {
  const open = useVizOpen();
  if (!open) return null;
  return <Viz />;
}

// The two contexts live in the untyped tree; this is the slice of each the
// visualizer reads, named here rather than typed as `{}`.
interface PlayerApi {
  audioRef: { current: PlaybackPort | null } | null;
  nowPlaying: {
    title?: string;
    name?: string;
    artist?: string;
    path?: string;
    album?: string | { name?: string; album?: string; year?: number | string };
    year?: number | string;
    genre?: string | null;
    bpm?: number | null;
    key?: string | null;
    analysis?: { camelot?: string; key_name?: string } | null;
  } | null;
  isPlaying: boolean;
  setIsPlaying: (next: boolean | ((p: boolean) => boolean)) => void;
  goNext?: () => void;
  goPrevious?: () => void;
  shuffleEnabled?: boolean;
  toggleShuffle?: () => void;
}
interface AnalyserApi {
  connectAudio: (el: PlaybackPort) => void;
  getAnalyserData: (kind: "timeDomain" | "timeDomainFloat" | "frequency") => { dataArray: Uint8Array | Float32Array; sampleRate?: number } | null;
  resume: () => void;
  getAnalyser?: () => AnalyserNode | null;
}

function Viz() {
  const { t } = useTranslation();
  const player = useAudioPlayer() as unknown as PlayerApi;
  const { audioRef, nowPlaying, isPlaying } = player;
  const { progress, duration, setProgress } = useAudioProgress() as {
    progress: number;
    duration: number;
    setProgress: (secs: number) => void;
  };
  const { connectAudio, getAnalyserData, resume, getAnalyser } = useAudioAnalyzer() as unknown as AnalyserApi;
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [still, setStill] = useState(false);
  const [motion, setMotion] = useState(readMotion);
  const [locked, setLocked] = useState(() => readPref(LOCK_KEY));
  const lockedRef = useRef(locked);
  const [params, setParams] = useState<Params>(readParams);
  useEffect(() => {
    lockedRef.current = locked;
    vizRef.current?.setLocked(locked);
    try {
      localStorage.setItem(LOCK_KEY, locked ? "1" : "0");
    } catch { /* per-viewer convenience only */ }
  }, [locked]);
  const vizRef = useRef<WaveRings | null>(null);

  // A knob writes straight into the engine (next frame) and into state for
  // its label; the saved copy follows a beat later.
  const setKnob = useCallback((next: Partial<Params>) => {
    vizRef.current?.set(next);
    setParams((p) => ({ ...p, ...next }));
  }, []);
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        localStorage.setItem(PARAMS_KEY, JSON.stringify(params));
      } catch { /* per-viewer convenience only */ }
    }, 300);
    return () => window.clearTimeout(id);
  }, [params]);
  // One ref per live row, so each row is its own element and never depends
  // on `white-space` to stay a row.
  const liveRef = useRef<Record<string, HTMLSpanElement | null>>({});

  // The live lines of the readout are written straight into the DOM ten
  // times a second; angles and loudness change every frame, and a React
  // render for each would cost more than the rings do.
  useEffect(() => {
    const id = window.setInterval(() => {
      const rows = liveRef.current;
      const viz = vizRef.current;
      if (!viz) return;
      const r = viz.readout();
      const sign = (n: number) => `${n < 0 ? "−" : "+"}${Math.abs(n).toFixed(1).padStart(5, "0")}°`;
      const hz = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(2)} kHz` : `${Math.round(n)} Hz`);
      const pos = audioRef?.current?.currentTime || 0;
      const set = (key: string, text: string) => {
        const el = rows[key];
        if (el && el.textContent !== text) el.textContent = text;
      };
      set("time", formatTime(pos));
      set("signal", [
        `${t("Level")} ${r.level.toFixed(2)} · RMS ${r.rms.toFixed(2)} · ${t("Swing")} ${r.swing.toFixed(2)}`,
        `${t("Bass_frequencies")} ${r.bass.toFixed(2)} · ${t("Mids")} ${r.mids.toFixed(2)} · ${t("Highs")} ${r.highs.toFixed(2)}`,
      ].join(" · "));
      set("view", `${t("Peak")} ${hz(r.peakHz)} · ${t("Centroid")} ${hz(r.centroidHz)} · ${t("Distance")} ${Math.round(r.distance)} · ${r.fps} fps · ${t("Yaw")} ${sign(r.yaw)} · ${t("Pitch")} ${sign(r.pitch)}`);
    }, READOUT_MS);
    return () => window.clearInterval(id);
  }, [t, audioRef]);

  useEffect(() => {
    vizRef.current?.setMotion(motion);
    try {
      localStorage.setItem(MOTION_KEY, motion ? "1" : "0");
    } catch { /* per-viewer convenience only */ }
  }, [motion]);

  // Esc leaves. Capture phase, so nothing under the overlay that swallows keys
  // (a focused control on the covered bar) can keep it from arriving.
  // Ctrl is the tilt's handbrake: held, the rings stay put while the mouse
  // moves; tapped on its own, it toggles the lock key. A Ctrl that was part
  // of a shortcut (Ctrl+C) toggles nothing.
  useEffect(() => {
    let ctrlTap = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeViz();
        return;
      }
      if (e.key === "Control") {
        if (e.repeat) return;
        ctrlTap = true;
        vizRef.current?.setLocked(true);
        return;
      }
      ctrlTap = false;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== "Control") return;
      if (ctrlTap) setLocked((l) => !l);
      else vizRef.current?.setLocked(lockedRef.current);
      ctrlTap = false;
    };
    const onBlur = () => {
      ctrlTap = false;
      vizRef.current?.setLocked(lockedRef.current);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    hostRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Join the song's audio graph (idempotent) so the analyser has a signal.
  useEffect(() => {
    const el = audioRef?.current;
    if (!el) return undefined;
    connectAudio(el);
    if (!el.paused && !el.ended) resume();
    const onPlay = () => resume();
    el.addEventListener("play", onPlay);
    return () => el.removeEventListener("play", onPlay);
  }, [audioRef, connectAudio, resume]);

  useEffect(() => {
    const analyser: AnalyserNode | null = getAnalyser?.() ?? null;
    if (!analyser) return undefined;
    const before = analyser.smoothingTimeConstant;
    analyser.smoothingTimeConstant = SMOOTHING;
    return () => {
      analyser.smoothingTimeConstant = before;
    };
  }, [getAnalyser]);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return undefined;
    const viz = createWaveRings(canvas, readParams());
    if (!viz) {
      setUnsupported(true);
      return undefined;
    }
    vizRef.current = viz;
    viz.setMotion(readMotion());
    viz.setLocked(readPref(LOCK_KEY));
    const tilt = readTilt();
    const tiltAt = tilt ?? DEFAULT_TILT;
    viz.setTilt(tiltAt.x, tiltAt.y);
    const saveTilt = () => {
      try {
        localStorage.setItem(TILT_KEY, JSON.stringify(viz.getTilt()));
      } catch { /* per-viewer convenience only */ }
    };

    const fit = () => {
      const r = host.getBoundingClientRect();
      // 1× on purpose: the rings are one-pixel additive lines, and at 2× each
      // is half as wide and the glow halves with it.
      viz.resize(r.width, r.height, 1);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(host);

    // The rings tilt toward the pointer and the cursor hides when it rests.
    let stillTimer = 0;
    let tiltTimer = 0;
    const onMove = (e: PointerEvent) => {
      const r = host.getBoundingClientRect();
      viz.tilt(e.clientX - r.left, e.clientY - r.top);
      setStill(false);
      window.clearTimeout(stillTimer);
      stillTimer = window.setTimeout(() => setStill(true), CURSOR_HIDE_MS);
      window.clearTimeout(tiltTimer);
      tiltTimer = window.setTimeout(saveTilt, 400);
    };
    const onWheel = (e: WheelEvent) => {
      viz.zoom(e.deltaY);
      setParams((p) => ({ ...p, distance: viz.get().distance }));
    };
    host.addEventListener("pointermove", onMove);
    host.addEventListener("wheel", onWheel, { passive: true });
    stillTimer = window.setTimeout(() => setStill(true), CURSOR_HIDE_MS);

    const silence = new Float32Array(512);
    const quiet = new Uint8Array(512);
    let raf = 0;
    const loop = () => {
      const time = getAnalyserData("timeDomainFloat");
      const freq = getAnalyserData("frequency");
      viz.frame(time?.dataArray ?? silence, (freq?.dataArray as Uint8Array | undefined) ?? quiet, freq?.sampleRate);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(stillTimer);
      window.clearTimeout(tiltTimer);
      saveTilt();
      ro.disconnect();
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("wheel", onWheel);
      vizRef.current = null;
      viz.dispose();
    };
  }, [getAnalyserData]);

  return (
    <div className={`viz-overlay${still ? " is-still" : ""}`} ref={hostRef} role="dialog" aria-label={t("Visualizer")} tabIndex={-1}>
      <canvas ref={canvasRef} className="viz-canvas" aria-hidden />
      {unsupported ? (
        <p className="viz-idle">{t("This machine has no WebGL, which the visualizer needs.")}</p>
      ) : !isPlaying ? (
        <p className="viz-idle">{t("Play a song to see the wave.")}</p>
      ) : null}
      <p className="viz-hint">{t("Move the mouse to tilt · scroll to zoom · Ctrl locks")}</p>
      <Readout t={t} track={nowPlaying} liveRef={liveRef} motion={motion} rings={Math.round(params.rings)} />
      <Pill
        t={t}
        title={nowPlaying?.title || nowPlaying?.name || ""}
        artist={nowPlaying?.artist || ""}
        isPlaying={isPlaying}
        motion={motion}
        onToggleMotion={() => setMotion((m) => !m)}
        shuffle={Boolean(player.shuffleEnabled)}
        onToggleShuffle={() => player.toggleShuffle?.()}
        params={params}
        onKnob={setKnob}
        locked={locked}
        onToggleLock={() => setLocked((l) => !l)}
        position={progress || 0}
        total={duration || 0}
        onToggle={() => player.setIsPlaying((p) => !p)}
        onPrev={() => player.goPrevious?.()}
        onNext={() => player.goNext?.()}
        onSeek={(frac: number) => {
          const el = audioRef?.current;
          if (!el || !duration) return;
          el.currentTime = frac * duration;
          setProgress(frac * duration);
        }}
      />
    </div>
  );
}

interface PillProps {
  t: (key: string) => string;
  title: string;
  artist: string;
  isPlaying: boolean;
  motion: boolean;
  onToggleMotion: () => void;
  shuffle: boolean;
  onToggleShuffle: () => void;
  params: Params;
  onKnob: (next: Partial<Params>) => void;
  locked: boolean;
  onToggleLock: () => void;
  position: number;
  total: number;
  onToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (frac: number) => void;
}

/**
 * Folded: the Flipspin mark in a glass disc, bottom left, turning while the song
 * plays. Unfolded (hover, or a
 * tap where there is no hover): ✕ · 🔒 · 🔀 · ⏮ · ⏯ · ⏭ · scrubber · auto-motion ·
 * knobs (a panel of the engine's parameters, unfolding under the keys; a
 * press anywhere else puts it away). A counter of playback seconds
 * since the last interaction folds it back; a pause stops the counter, so a
 * paused song keeps its controls out.
 */
function Pill({ t, title, artist, isPlaying, motion, onToggleMotion, shuffle, onToggleShuffle, params, onKnob, locked, onToggleLock, position, total, onToggle, onPrev, onNext, onSeek }: PillProps) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [knobs, setKnobs] = useState(false);
  const knobsRef = useRef<HTMLDivElement>(null);
  const knobsKeyRef = useRef<HTMLButtonElement>(null);
  const runFor = useRef(0);
  const open = hover || pinned || knobs;

  // A press anywhere but the panel or its key puts the knobs away; the rings,
  // the transport, the readout. The key is excluded so it still toggles.
  useEffect(() => {
    if (!knobs) return undefined;
    const onDown = (e: PointerEvent) => {
      const el = e.target as Node | null;
      if (knobsRef.current?.contains(el) || knobsKeyRef.current?.contains(el)) return;
      setKnobs(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [knobs]);

  const interacted = useCallback(() => {
    runFor.current = 0;
  }, []);

  useEffect(() => {
    // The knobs hold the pill open: nobody wants a panel folding under a slider.
    if (!pinned || hover || knobs || !isPlaying) {
      runFor.current = 0;
      return undefined;
    }
    const id = window.setInterval(() => {
      runFor.current += 1;
      if (runFor.current >= FOLD_AFTER_S) setPinned(false);
    }, 1000);
    return () => window.clearInterval(id);
  }, [pinned, hover, knobs, isPlaying]);

  const act = (fn: () => void) => () => {
    interacted();
    fn();
  };

  return (
    <div
      className={`viz-pill${open ? " is-open" : ""}`}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") setHover(true);
      }}
      onPointerLeave={(e) => {
        if (e.pointerType === "mouse") setHover(false);
      }}
      onPointerDown={interacted}
    >
      <div className="viz-pill-body">
      {open ? (
        <>
          <div className="viz-pill-song" aria-live="polite">
            <Marquee className="viz-pill-title" text={title || t("Nothing playing")} />
            {artist && <Marquee className="viz-pill-artist" text={artist} />}
          </div>
          <div className="viz-pill-row">
            <button type="button" className="lyrics-tb viz-key" onClick={act(closeViz)} title={t("Close")} aria-label={t("Close")}>
              <X size={16} strokeWidth={2.5} aria-hidden />
            </button>
            <button type="button" className={`lyrics-tb viz-key${locked ? " is-on" : ""}`} onClick={act(onToggleLock)} aria-pressed={locked} title={locked ? t("Unlock the tilt") : t("Lock the tilt (the mouse stops moving the rings)")}>
              {locked ? <Lock size={15} strokeWidth={2.5} aria-hidden /> : <LockOpen size={15} strokeWidth={2.5} aria-hidden />}
            </button>
            <i className="viz-pill-sep" aria-hidden />
            <button type="button" className={`lyrics-tb viz-key${shuffle ? " is-on" : ""}`} onClick={act(onToggleShuffle)} aria-pressed={shuffle} title={t("Shuffle")}>
              <Shuffle size={15} strokeWidth={2.5} aria-hidden />
            </button>
            <button type="button" className="lyrics-tb viz-key" onClick={act(onPrev)} title={t("Previous")}>
              <SkipBack size={16} strokeWidth={2.5} aria-hidden />
            </button>
            <button type="button" className="lyrics-tb lyrics-tb--play viz-key viz-key--play" onClick={act(onToggle)} title={t("Play / pause")}>
              {isPlaying ? <Pause size={20} strokeWidth={2.5} fill="currentColor" aria-hidden /> : <Play size={20} strokeWidth={2.5} fill="currentColor" style={{ marginLeft: 2 }} aria-hidden />}
            </button>
            <button type="button" className="lyrics-tb viz-key" onClick={act(onNext)} title={t("Next")}>
              <SkipForward size={16} strokeWidth={2.5} aria-hidden />
            </button>
            <i className="viz-pill-sep" aria-hidden />
            <div className="viz-pill-seek lyrics-bar-seek">
              <span>{formatTime(position)}</span>
              <Track value={total > 0 ? position / total : 0} onChange={(f: number) => { interacted(); onSeek(f); }} disabled={!total} ariaLabel={t("Position")} />
              <span className="lyrics-bar-total">{formatTime(total)}</span>
            </div>
            <i className="viz-pill-sep" aria-hidden />
            <button type="button" className={`lyrics-tb viz-key${motion ? " is-on" : ""}`} onClick={act(onToggleMotion)} aria-pressed={motion} title={motion ? t("Turn off auto motion") : t("Auto motion")}>
              <Rotate3d size={16} strokeWidth={2.5} aria-hidden />
            </button>
            <button type="button" ref={knobsKeyRef} className={`lyrics-tb viz-key${knobs ? " is-on" : ""}`} onClick={act(() => setKnobs((k) => !k))} aria-pressed={knobs} aria-expanded={knobs} title={t("Visualizer settings")}>
              <SlidersHorizontal size={16} strokeWidth={2.5} aria-hidden />
            </button>
          </div>
          {knobs && (
            <div className="viz-knobs" ref={knobsRef} role="group" aria-label={t("Visualizer settings")}>
              {KNOBS.map((k) => (
                <label key={k.key} className="viz-knob">
                  <span className="viz-knob-name">{t(k.label)}</span>
                  <input
                    type="range"
                    min={k.min}
                    max={k.max}
                    step={k.step}
                    value={params[k.key]}
                    onChange={(e) => onKnob({ [k.key]: Number(e.target.value) })}
                    onPointerDown={interacted}
                  />
                  <span className="viz-knob-value">{k.show(params[k.key])}</span>
                </label>
              ))}
              <button type="button" className="viz-knob-reset" onClick={() => onKnob({ ...DEFAULT_PARAMS })} title={t("Factory values")}>
                <RotateCcw size={12} strokeWidth={2.5} aria-hidden /> {t("Reset")}
              </button>
            </div>
          )}
        </>
      ) : (
        <button
          type="button"
          className={`viz-disc${isPlaying ? " is-playing" : ""}`}
          onClick={() => setPinned(true)}
          title={t("Controls")}
          aria-label={t("Controls")}
          aria-expanded={false}
        >
          <img src={krobiMark} alt="" width={40} height={40} draggable={false} />
        </button>
      )}
      </div>
    </div>
  );
}

/**
 * One line of text in a fixed-width box. Text that fits sits still; text that
 * does not glides to its end and back, slowly, so the whole title can be read
 * without the pill growing to fit it. Measured after layout, re-measured when
 * the text changes.
 */
function Marquee({ text, className }: { text: string; className: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    const b = box.current;
    const i = inner.current;
    if (!b || !i) return;
    setShift(Math.max(0, i.scrollWidth - b.clientWidth));
  }, [text]);
  const long = shift > 0;
  return (
    <span className={`viz-marquee ${className}${long ? " is-long" : ""}`} ref={box} title={long ? text : undefined}>
      <span
        ref={inner}
        style={long ? { "--viz-shift": `-${shift}px`, animationDuration: `${Math.max(6, shift / 30)}s` } as React.CSSProperties : undefined}
      >
        {text}
      </span>
    </span>
  );
}

/**
 * A heads-up readout, for a song: what is playing and what the rings are
 * doing, in a monospace corner nobody has to look at. The song lines render
 * once per track; the live line is a ref the overlay writes into.
 */
function Readout({ t, track, liveRef, motion, rings }: {
  t: (key: string) => string;
  track: PlayerApi["nowPlaying"];
  liveRef: React.RefObject<Record<string, HTMLSpanElement | null>>;
  motion: boolean;
  rings: number;
}) {
  const live = (key: string) => (el: HTMLSpanElement | null) => {
    liveRef.current[key] = el;
  };
  const title = track?.title || track?.name || "";
  const album = typeof track?.album === "object" ? track?.album?.name || track?.album?.album || "" : track?.album || "";
  const year = track?.year ?? (typeof track?.album === "object" ? track?.album?.year : undefined);
  const ext = (track?.path || "").split(".").pop()?.toUpperCase() || "";
  const camelot = track?.analysis?.camelot;
  const keyName = track?.analysis?.key_name || track?.key;
  const facts = [
    album && `${album}${year ? ` (${year})` : ""}`,
    track?.bpm && `${track.bpm} BPM`,
    keyName && `${keyName}${camelot ? ` · ${camelot}` : ""}`,
    track?.genre,
    ext && ext.length <= 4 ? ext : null,
  ].filter(Boolean);
  return (
    <div className="viz-readout" aria-hidden>
      {title ? (
        <>
          <span className="viz-readout-name">
            {title}
            {track?.artist ? <span className="dim"> — {track.artist}</span> : null}
            <span className="dim"> · </span>
            <span className="viz-readout-line" ref={live("time")} />
          </span>
          {facts.length > 0 && <span className="dim">{facts.join(" · ")}</span>}
        </>
      ) : (
        <span className="dim">{t("Nothing playing")}</span>
      )}
      <span className="dim viz-readout-line" ref={live("signal")} />
      <span className="dim viz-readout-line" ref={live("view")} />
      <span className="dim">{rings} {t("rings")} · 512 {t("samples")} · 128 {t("bands")}{motion ? ` · ${t("motion")}` : ""}</span>
    </div>
  );
}
