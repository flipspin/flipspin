// ───────────────────────── Frequency-domain views ─────────────────────────
// Both the spectrum analyzer and the wave decomposer read the FFT magnitude
// spectrum (getByteFrequencyData → 0..255 per bin). Bin i is centered on
// i · (sampleRate / fftSize) Hz, and fftSize === 2 · bufferLength.
import type { Surface } from './waveformDraw';
import type { WaveformPalette } from './waveformPalette';

/** One read of the shared analyser (`getAnalyserData`). */
export interface AnalyserFrame {
  dataArray: Uint8Array;
  bufferLength: number;
  sampleRate: number;
}

/** Smoothed-magnitude and peak-hold buffers the spectrum keeps across frames. */
export interface SpectrumState {
  mags: Float32Array | null;
  peaks: Float32Array | null;
}

/** Phase clock and per-lane amplitude/frequency buffers the decomposer keeps across frames. */
export interface DecomposerState {
  t: number;
  amps: Float32Array | null;
  freqs: Float32Array | null;
}

const SPECTRUM_FMIN = 30;          // Hz, low edge of the displayed range
const SPECTRUM_BANDS = 96;         // log-spaced columns drawn across the panel
const SPECTRUM_PEAK_DECAY = 0.012; // per-frame fall of the peak-hold caps (0..1)
const SPECTRUM_RISE = 0.5;         // attack smoothing toward a louder value
const SPECTRUM_FALL = 0.16;        // release smoothing toward a quieter value
const AXIS_LABEL_HZ = [100, 1000, 10000];

/** "440", "1.2k", "10k"; the axis and lane captions. */
export function formatHz(f: number): string {
  return f >= 1000 ? `${Math.round(f / 100) / 10}k` : `${Math.round(f)}`;
}

/** frac (0..1) → frequency, logarithmic between fMin and fMax. */
export function freqAtFrac(frac: number, fMin: number, fMax: number): number {
  return fMin * Math.pow(fMax / fMin, frac);
}
/** The inverse of `freqAtFrac`. */
export function fracAtFreq(f: number, fMin: number, fMax: number): number {
  return Math.log(f / fMin) / Math.log(fMax / fMin);
}

// Spectrum analyzer: log-frequency filled curve with peak-hold caps and a faint
// Hz axis. `state` carries the smoothed-magnitude and peak buffers across frames.
export function drawSpectrum(surface: Surface, ctx: CanvasRenderingContext2D, data: AnalyserFrame, state: SpectrumState, palette: WaveformPalette): void {
  const { dataArray, bufferLength, sampleRate } = data;
  const W = surface.width;
  const H = surface.height;
  const outline = palette.outline;

  const fMax = Math.min(sampleRate / 2, 20000);
  const fMin = SPECTRUM_FMIN;
  const binHz = sampleRate / (bufferLength * 2); // fftSize = 2 · bufferLength

  let { mags, peaks } = state;
  if (!mags || mags.length !== SPECTRUM_BANDS) {
    mags = state.mags = new Float32Array(SPECTRUM_BANDS);
    peaks = state.peaks = new Float32Array(SPECTRUM_BANDS);
  }

  const bottom = H - 13; // strip below the curve for axis labels
  const top = 6;
  const usableH = Math.max(1, bottom - top);

  // Per band: max bin magnitude over the band's frequency range, then smoothed
  // (fast attack / slow release) so the curve is lively but not jittery.
  for (let i = 0; i < SPECTRUM_BANDS; i++) {
    let b0 = Math.floor(freqAtFrac(i / SPECTRUM_BANDS, fMin, fMax) / binHz);
    let b1 = Math.ceil(freqAtFrac((i + 1) / SPECTRUM_BANDS, fMin, fMax) / binHz);
    if (b0 < 1) b0 = 1;
    if (b1 >= bufferLength) b1 = bufferLength - 1;
    if (b1 < b0) b1 = b0;
    let peak = 0;
    for (let b = b0; b <= b1; b++) {
      if (dataArray[b] > peak) peak = dataArray[b];
    }
    const target = peak / 255;
    mags[i] += (target - mags[i]) * (target > mags[i] ? SPECTRUM_RISE : SPECTRUM_FALL);
    peaks[i] = Math.max(mags[i], peaks[i] - SPECTRUM_PEAK_DECAY);
  }

  const xOf = (i: number) => (i + 0.5) * (W / SPECTRUM_BANDS);
  const yOf = (m: number) => bottom - m * usableH;

  // Filled curve (smoothed with midpoint quadratics), then outline on top.
  const traceCurve = () => {
    ctx.moveTo(xOf(0), yOf(mags[0]));
    for (let i = 1; i < SPECTRUM_BANDS; i++) {
      const xc = (xOf(i - 1) + xOf(i)) / 2;
      const yc = (yOf(mags[i - 1]) + yOf(mags[i])) / 2;
      ctx.quadraticCurveTo(xOf(i - 1), yOf(mags[i - 1]), xc, yc);
    }
    ctx.lineTo(xOf(SPECTRUM_BANDS - 1), yOf(mags[SPECTRUM_BANDS - 1]));
  };

  const grad = ctx.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, palette.fill);
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.beginPath();
  ctx.moveTo(0, bottom);
  traceCurve();
  ctx.lineTo(W, bottom);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  traceCurve();
  ctx.strokeStyle = outline;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Peak-hold caps.
  ctx.fillStyle = outline;
  for (let i = 0; i < SPECTRUM_BANDS; i += 2) {
    if (peaks[i] < 0.02) continue;
    ctx.fillRect(xOf(i) - 1.5, yOf(peaks[i]) - 1, 3, 2);
  }

  // Log frequency axis labels.
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (const f of AXIS_LABEL_HZ) {
    if (f <= fMin || f >= fMax) continue;
    const lx = fracAtFreq(f, fMin, fMax) * W;
    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lx, bottom);
    ctx.lineTo(lx, bottom + 3);
    ctx.stroke();
    ctx.fillStyle = palette.midline;
    ctx.fillText(formatHz(f), lx, H - 2);
  }
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

// Wave decomposer (Fourier synthesis): pull the strongest peaks out of the
// spectrum each frame, draw each as its own scrolling sine in a labelled lane,
// and draw their superposition (Σ) as the reconstructed wave on top.
const DECOMP_COMPONENTS = 5;       // dominant peaks pulled from the spectrum
const DECOMP_PEAK_THRESHOLD = 40;  // 0..255, ignore bins quieter than this
const DECOMP_BASE_CYCLES = 1.4;    // on-screen cycles for the lowest component
const DECOMP_MAX_CYCLES = 26;      // cap so high components don't alias to mush
const DECOMP_SPEED = 0.05;         // phase advance per frame

export interface SpectralPeak {
  bin: number;
  mag: number;
}

/** Top-k local maxima of the magnitude spectrum, returned sorted by frequency. */
export function findSpectralPeaks(dataArray: ArrayLike<number>, bufferLength: number, k: number, threshold: number): SpectralPeak[] {
  const peaks: SpectralPeak[] = [];
  for (let i = 2; i < bufferLength - 1; i++) {
    const v = dataArray[i];
    if (v >= threshold && v >= dataArray[i - 1] && v > dataArray[i + 1]) {
      peaks.push({ bin: i, mag: v });
      i++; // a peak's immediate neighbour can't also be a peak
    }
  }
  peaks.sort((a, b) => b.mag - a.mag);
  peaks.length = Math.min(peaks.length, k);
  peaks.sort((a, b) => a.bin - b.bin);
  return peaks;
}

export function drawDecomposer(surface: Surface, ctx: CanvasRenderingContext2D, data: AnalyserFrame, state: DecomposerState, palette: WaveformPalette): void {
  const { dataArray, bufferLength, sampleRate } = data;
  const W = surface.width;
  const H = surface.height;
  const outline = palette.outline;
  const binHz = sampleRate / (bufferLength * 2);

  // Smoothed per-lane amplitude/frequency buffers (lane j = j-th component by
  // frequency). Lanes with no current component decay toward zero and vanish.
  let { amps, freqs } = state;
  if (!amps || amps.length !== DECOMP_COMPONENTS) {
    amps = state.amps = new Float32Array(DECOMP_COMPONENTS);
    freqs = state.freqs = new Float32Array(DECOMP_COMPONENTS);
  }

  const found = findSpectralPeaks(dataArray, bufferLength, DECOMP_COMPONENTS, DECOMP_PEAK_THRESHOLD);
  for (let j = 0; j < DECOMP_COMPONENTS; j++) {
    const p = found[j];
    amps[j] = amps[j] * 0.7 + (p ? p.mag / 255 : 0) * 0.3;
    if (p) freqs[j] = freqs[j] > 0 ? freqs[j] * 0.6 + p.bin * binHz * 0.4 : p.bin * binHz;
  }

  state.t += DECOMP_SPEED;
  const t = state.t;

  // Precompute the active lanes' angular frequency / scroll phase / amplitude so
  // the per-pixel loops below stay tight.
  const fLow = (found[0] ? freqs[0] : 0) || 1;
  const omega: number[] = [];
  const phase: number[] = [];
  const amp: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j < found.length; j++) {
    if (amps[j] <= 0.01) continue;
    const cycles = Math.min(DECOMP_MAX_CYCLES, Math.max(1, Math.round((freqs[j] / fLow) * DECOMP_BASE_CYCLES)));
    omega.push((2 * Math.PI * cycles) / W);
    phase.push(t * (0.4 + cycles * 0.05));
    amp.push(amps[j]);
    idx.push(j);
  }
  if (idx.length === 0) return;

  const STEP = 2;

  // ── Top region: reconstructed sum (Σ of the components) ──
  const sumH = H * 0.42;
  const sumCenter = sumH * 0.5;
  let sumAmp = 0;
  for (const a of amp) sumAmp += a;
  const sumScale = (sumH * 0.42) / Math.max(0.05, sumAmp);

  ctx.beginPath();
  for (let x = 0; x <= W; x += STEP) {
    let s = 0;
    for (let m = 0; m < idx.length; m++) s += amp[m] * Math.sin(omega[m] * x - phase[m]);
    const y = sumCenter - s * sumScale;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = outline;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.fillStyle = outline;
  ctx.font = 'bold 13px serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Σ', 6, 4);

  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, sumH);
  ctx.lineTo(W, sumH);
  ctx.stroke();

  // ── Bottom region: each component as its own faint sine, labelled in Hz ──
  const laneH = (H - sumH) / idx.length;
  ctx.font = '9px monospace';
  for (let m = 0; m < idx.length; m++) {
    const laneCenter = sumH + laneH * (m + 0.5);
    const laneAmp = laneH * 0.4 * Math.min(1, Math.max(0.12, amp[m] / 0.6));

    ctx.beginPath();
    for (let x = 0; x <= W; x += STEP) {
      const y = laneCenter - Math.sin(omega[m] * x - phase[m]) * laneAmp;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.globalAlpha = Math.min(0.9, 0.3 + amp[m]);
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.fillStyle = palette.midline;
    ctx.textBaseline = 'top';
    ctx.fillText(`${formatHz(freqs[idx[m]])} Hz`, 6, sumH + laneH * m + 2);
  }
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}
