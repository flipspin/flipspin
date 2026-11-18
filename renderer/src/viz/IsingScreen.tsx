import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { ISING_COLS, ISING_ROWS, ISING_T, STEPS, formatT, makeLattice, metropolis, quench, settled, type Lattice } from "./isingLattice";
import "./ising-screen.css";

/** Draw only flipped spins at up to 15 fps to limit idle rendering work.
 * Pause while hidden, show a still frame for reduced motion, and stop when T=0 settles. */
const FPS = 15;
const THERMALISE_SWEEPS = 40;

/** Off spins: the on colour at this opacity (dark screen). */
const OFF_ALPHA = 0.12;
/** On a light screen the off spins are pale coral, so they show more. */
const OFF_ALPHA_LIGHT = 0.22;
/** Dot radius as a share of the cell's shorter side. */
const DOT = 0.36;

//  colour: theme vars, with a contrast check against the dark screen
function rgbOf(ctx: CanvasRenderingContext2D, colour: string): [number, number, number] | null {
  ctx.fillStyle = "#000";
  ctx.fillStyle = colour;
  const v = String(ctx.fillStyle);
  const hex = v.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((o) => parseInt(hex[1].slice(o, o + 2), 16)) as [number, number, number];
  const rgb = v.match(/rgba?\(([^)]+)\)/);
  if (rgb) return rgb[1].split(",").slice(0, 3).map((n) => Number.parseFloat(n)) as [number, number, number];
  return null;
}
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

type Palette = { bg: string; on: string; light: boolean };

/** The first candidate that stands out on `bg` (≥ 3:1), else the last. */
function readPalette(screen: HTMLElement, ctx: CanvasRenderingContext2D): Palette {
  const bg = getComputedStyle(screen).backgroundColor || "black";
  const root = getComputedStyle(document.documentElement);
  const candidates = ["--viz-ising", "--coral", "--panel"]
    .map((name) => root.getPropertyValue(name).trim())
    .filter(Boolean);
  const bgRgb = rgbOf(ctx, bg);
  // A light screen (paper) draws coral as is: the dots are decoration, and
  // coral on paper (~2.4:1) is the look; the contrast pick is for dark screens.
  if (bgRgb && luminance(bgRgb) > 0.5) {
    const coral = root.getPropertyValue("--coral").trim() || "coral";
    return { bg, on: coral, light: true };
  }
  const on =
    candidates.find((c) => {
      const rgb = rgbOf(ctx, c);
      return !bgRgb || !rgb || contrast(rgb, bgRgb) >= 3;
    }) ?? candidates[candidates.length - 1] ?? "coral";
  return { bg, on, light: false };
}

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const COLLAPSED_KEY = "krobi.isingCollapsed";

export default function IsingScreen() {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  // Folded to its header line, remembered on this computer. The canvas stays
  // mounted (its loop sleeps at T 0 and redraws when it is shown again).
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "1"; } catch { return false; }
  });
  const toggleCollapsed = () => setCollapsed((v) => {
    try { localStorage.setItem(COLLAPSED_KEY, v ? "0" : "1"); } catch { /* this session only */ }
    return !v;
  });
  const stepRef = useRef(0);
  // Set by the drawing effect: (re)start the loop after leaving idle.
  const wake = useRef<() => void>(() => {});
  // Folded, the lattice is idle: the loop stops at its next frame and is
  // woken again when the screen comes back.
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  useEffect(() => { if (!collapsed) wake.current(); }, [collapsed]);
  const screenRef = useRef<HTMLButtonElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const lattice = useRef<Lattice | null>(null);
  if (!lattice.current) {
    const L = makeLattice(ISING_COLS, ISING_ROWS, ISING_T);
    metropolis(L, L.cols * L.rows * THERMALISE_SWEEPS); // domains from the first frame
    quench(L); // …cooled to T 0, so the idle start is already still
    L.T = STEPS[0].T;
    lattice.current = L;
  }

  const next = useCallback(() => {
    const n = (stepRef.current + 1) % STEPS.length;
    stepRef.current = n;
    if (lattice.current) lattice.current.T = STEPS[n].T;
    setStep(n);
    wake.current();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const screen = screenRef.current;
    const L = lattice.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !screen || !L || !ctx) return;

    let palette: Palette = { bg: "black", on: "coral", light: false };
    let stamps: { on: HTMLCanvasElement; off: HTMLCanvasElement } | null = null;
    let cw = 0;
    let ch = 0;

    // A dot pre-rendered once per size and theme; each frame only copies it.
    const stamp = (alpha: number) => {
      const c = document.createElement("canvas");
      c.width = Math.ceil(cw);
      c.height = Math.ceil(ch);
      const s = c.getContext("2d");
      if (s) {
        s.globalAlpha = alpha;
        s.fillStyle = palette.on;
        s.beginPath();
        s.arc(cw / 2, ch / 2, Math.min(cw, ch) * DOT, 0, Math.PI * 2);
        s.fill();
      }
      return c;
    };
    const cell = (i: number) => {
      if (!stamps) return;
      const x = (i % L.cols) * cw;
      const y = ((i / L.cols) | 0) * ch;
      ctx.fillStyle = palette.bg;
      ctx.fillRect(x, y, cw, ch);
      ctx.drawImage(L.s[i] === 1 ? stamps.on : stamps.off, x, y);
    };
    const full = () => {
      const r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(r.width * dpr);
      canvas.height = Math.round(r.height * dpr);
      cw = canvas.width / L.cols;
      ch = canvas.height / L.rows;
      palette = readPalette(screen, ctx);
      stamps = { on: stamp(1), off: stamp(palette.light ? OFF_ALPHA_LIGHT : OFF_ALPHA) };
      ctx.fillStyle = palette.bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let i = 0; i < L.s.length; i++) cell(i);
    };
    full();

    const resize = new ResizeObserver(full);
    resize.observe(canvas);
    // Palette or mode changes repaint everything with the new colours.
    const theme = new MutationObserver(full);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-mode", "class", "style"] });

    let frame = 0;
    let last = 0;
    const flipped = new Set<number>();
    const still = reducedMotion();
    const tick = (now: number) => {
      if (collapsedRef.current || (L.T <= 0 && settled(L))) {
        frame = 0; // T 0 has nothing left to flip: sleep until a click
        return;
      }
      const share = STEPS[stepRef.current].attempts;
      frame = requestAnimationFrame(tick);
      if (document.hidden || now - last < 1000 / FPS) return;
      last = now;
      flipped.clear();
      metropolis(L, Math.ceil(L.cols * L.rows * share), flipped);
      flipped.forEach(cell);
    };
    const start = () => {
      if (still || frame || document.hidden || collapsedRef.current) return;
      last = 0;
      frame = requestAnimationFrame(tick);
    };
    wake.current = start;
    start();
    const onVisibility = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      start();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(frame);
      wake.current = () => {};
      resize.disconnect();
      theme.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const T = STEPS[step].T;
  return (
    <div className="ising">
      <div className="ising__head">
        <span aria-hidden>ising</span>
        <span className="ising__head-end">
          {!collapsed && <span aria-hidden>T {formatT(T)}</span>}
          <button
            type="button"
            className="ising__fold"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("Show the Ising") : t("Hide the Ising")}
            title={collapsed ? t("Show the Ising") : t("Hide the Ising")}
          >
            <ChevronDown size={14} aria-hidden style={{ transform: collapsed ? "rotate(-90deg)" : undefined }} />
          </button>
        </span>
      </div>
      <button
        ref={screenRef}
        type="button"
        hidden={collapsed}
        className="ising__screen"
        onClick={next}
        aria-label={t("Ising at T {{t}}", { t: formatT(T) })}
        title={t("Change the Ising temperature")}
      >
        <canvas ref={canvasRef} className="ising__canvas" aria-hidden />
      </button>
    </div>
  );
}
