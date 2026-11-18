import type { PlaybackPort } from '../player/engine/PlaybackPort';
import { useEffect, useRef, type RefObject } from 'react';
import { drawIdleOscilloscope, getGenerator } from './idleOscilloscope';
import { drawDecomposer, drawSpectrum, type AnalyserFrame, type DecomposerState, type SpectrumState } from './spectrumDraw';
import { FREQUENCY_VIEW_MODES, IDLE_OMEGA } from './waveformChoices';
import { animateBars, animateSineEnvelope, animateSineLine, drawGrid, drawSimulatedWaveform, type Surface } from './waveformDraw';
import type { WaveformPalette } from './waveformPalette';

// Throttle idle decoration to 12fps. Keep live audio on requestAnimationFrame
// because an interval cap can skip alternating frames when callbacks arrive slightly early.
const IDLE_INTERVAL = 1000 / 12;

export interface WaveformLoopInput {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  containerRef: RefObject<HTMLElement | null>;
  audioRef: RefObject<PlaybackPort | null> | undefined;
  paletteRef: RefObject<WaveformPalette>;
  dimensions: Surface;
  /** Draw the idle figure instead of live audio. */
  showIdle: boolean;
  idleWaveType: string;
  viewMode: string;
  isPlaying: boolean;
  isConnected: boolean;
  hasError: boolean;
  getAnalyserData: (type: 'frequency' | 'timeDomain') => AnalyserFrame | null;
}

/**
 * The panel's single animation loop: the idle figure when no song is playing,
 * the chosen live view otherwise. Rebuilt whenever what it draws changes;
 * paused while the document is hidden.
 */
export function useWaveformLoop({
  canvasRef, containerRef, audioRef, paletteRef, dimensions, showIdle, idleWaveType, viewMode,
  isPlaying, isConnected, hasError, getAnalyserData,
}: WaveformLoopInput): void {
  const animationRef = useRef<number | null>(null);
  // Persistent state for the frequency views that need continuity across frames
  // (spectrum peak-hold + smoothing buffers, decomposer phase/amplitude buffers).
  // A ref so it survives the animate-effect being torn down and rebuilt.
  const vizStateRef = useRef<{ spec: SpectrumState; decomp: DecomposerState }>({
    spec: { mags: null, peaks: null },
    decomp: { t: 0, amps: null, freqs: null },
  });

  useEffect(() => {
    if (!canvasRef.current || !containerRef.current) return;

    const container = containerRef.current;
    const w = dimensions.width || container.offsetWidth || container.clientWidth || 300;
    const h = dimensions.height || container.offsetHeight || container.clientHeight || 100;
    if (w < 1 || h < 1) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // Back the canvas at device resolution and draw in CSS pixels through the
    // transform: the idle figure has type and hairlines that blur at 1×. The
    // live renderers only read `.width`/`.height` off what they are handed, so
    // they get a CSS-sized stand-in and keep their geometry and line weights.
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const surface: Surface = { width: w, height: h };

    // Rasterize the static grid after resize and reuse it each frame to avoid repeated path drawing.
    const gridCanvas = document.createElement('canvas');
    gridCanvas.width = canvas.width;
    gridCanvas.height = canvas.height;
    const gridCtx = gridCanvas.getContext('2d');
    if (gridCtx) {
      gridCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawGrid(gridCtx, w, h, paletteRef.current);
    }

    let lastFrame = 0;
    let disposed = false;

    const requestNextFrame = () => {
      if (!disposed && !document.hidden && animationRef.current == null) {
        animationRef.current = requestAnimationFrame(animate);
      }
    };

    const drawLive = (palette: WaveformPalette) => {
      ctx.drawImage(gridCanvas, 0, 0, w, h);
      ctx.save();
      const dataType = FREQUENCY_VIEW_MODES.has(viewMode) ? 'frequency' : 'timeDomain';
      const analyzerData = getAnalyserData(dataType);
      if (!analyzerData) {
        // spectrum/decomposer have no meaningful simulated fallback; the grid
        // alone reads as "warming up"; the older modes keep their fake wave.
        if (viewMode !== 'spectrum' && viewMode !== 'decomposer') {
          drawSimulatedWaveform(
            ctx,
            surface,
            palette,
            audioRef?.current?.currentTime || 0,
            audioRef?.current?.duration || 1,
            viewMode,
          );
        }
      } else if (viewMode === 'filled') {
        animateSineEnvelope(surface, ctx, analyzerData.dataArray, analyzerData.bufferLength, palette);
      } else if (viewMode === 'line') {
        animateSineLine(surface, ctx, analyzerData.dataArray, analyzerData.bufferLength, palette);
      } else if (viewMode === 'spectrum') {
        drawSpectrum(surface, ctx, analyzerData, vizStateRef.current.spec, palette);
      } else if (viewMode === 'decomposer') {
        drawDecomposer(surface, ctx, analyzerData, vizStateRef.current.decomp, palette);
      } else {
        animateBars(surface, ctx, analyzerData.dataArray, analyzerData.bufferLength, palette);
      }
      ctx.restore();
    };

    const animate = (timestamp = 0) => {
      animationRef.current = null;
      if (disposed || document.hidden) return;
      requestNextFrame();
      if (showIdle && timestamp - lastFrame < IDLE_INTERVAL) return;
      lastFrame = timestamp;

      ctx.clearRect(0, 0, w, h);
      const palette = paletteRef.current;

      if (showIdle) {
        // Clock-driven, so the speed is the same at 30 and 120 fps and a resize
        // (which rebuilds this effect) doesn't snap the point back to θ = 0.
        const theta = (timestamp / 1000) * IDLE_OMEGA;
        drawIdleOscilloscope(ctx, w, h, theta, getGenerator(idleWaveType), {
          ink: palette.ink,
          muted: palette.inkMuted,
          accent: palette.outline,
        });
      } else if (!hasError && (isPlaying && isConnected && audioRef?.current?.src)) {
        drawLive(palette);
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (animationRef.current != null) cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      } else {
        requestNextFrame();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    requestNextFrame();
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (animationRef.current != null) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    };
  }, [canvasRef, containerRef, paletteRef, showIdle, idleWaveType, isPlaying, dimensions, viewMode, getAnalyserData, hasError, isConnected, audioRef]);
}
