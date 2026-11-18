// The Waveform panel's time-domain renderers (and the bars, which share their LED
// segments), plus the simulated wave shown while the analyser warms up. Each
// draws in CSS pixels onto a context whose DPR transform the caller owns;
// `surface` is the CSS-sized box, not the backing canvas.
import type { WaveformPalette } from './waveformPalette';

export interface Surface {
  width: number;
  height: number;
}

export function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, palette: WaveformPalette): void {
  const boxSize = Math.max(12, Math.min(20, Math.floor(width / 20)));
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 1;
  // Batch every grid line into ONE path + ONE stroke. Issuing a separate
  // beginPath/stroke per line meant ~50-70 rasterization passes per frame.
  ctx.beginPath();
  for (let x = 0; x <= width; x += boxSize) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = 0; y <= height; y += boxSize) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
}

// No fill: centered oscillating line (old style)
export function animateSineLine(surface: Surface, ctx: CanvasRenderingContext2D, dataArray: Uint8Array, bufferLength: number, palette: WaveformPalette): void {
  const { width, height } = surface;
  const sliceWidth = width / bufferLength;
  const centerY = height / 2;
  const ampScale = height * 0.35;

  ctx.translate(0, centerY);
  ctx.strokeStyle = palette.outline;
  ctx.lineWidth = 3;
  ctx.beginPath();

  let x = 0;
  for (let i = 0; i < bufferLength; i++) {
    const v = dataArray[i] / 128.0;
    const y = (v - 1) * ampScale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    x += sliceWidth;
  }
  ctx.lineTo(width, 0);
  ctx.stroke();
}

// Filled amplitude envelope (bottom-up), with orange outline and lighter fill
export function animateSineEnvelope(surface: Surface, ctx: CanvasRenderingContext2D, dataArray: Uint8Array, bufferLength: number, palette: WaveformPalette): void {
  const { width, height } = surface;
  const sliceWidth = width / bufferLength;
  const centerY = height / 2;
  const ampScale = height * 0.35;

  ctx.beginPath();
  ctx.moveTo(0, height);

  let x = 0;
  for (let i = 0; i < bufferLength; i++) {
    const v = dataArray[i] / 128.0;
    const y = centerY - (v - 1) * ampScale;
    ctx.lineTo(x, y);
    x += sliceWidth;
  }

  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fillStyle = palette.fill;
  ctx.fill();
  ctx.strokeStyle = palette.outline;
  ctx.lineWidth = 3;
  ctx.stroke();

  // Dashed midline echoing the waveform. Recompute each y from dataArray rather
  // than buffering 512 points per frame; that allocation churned the GC at the
  // native refresh rate.
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = palette.midline;
  ctx.lineWidth = 1;
  ctx.beginPath();
  x = 0;
  for (let i = 0; i < bufferLength; i++) {
    const v = dataArray[i] / 128.0;
    const y = centerY - (v - 1) * ampScale;
    const midY = y * 0.3 + centerY * 0.7;
    if (i === 0) ctx.moveTo(x, midY);
    else ctx.lineTo(x, midY);
    x += sliceWidth;
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

const SEGMENT_HEIGHT = 4;
const SEGMENT_GAP = 2;

function drawSegmentedBar(ctx: CanvasRenderingContext2D, x: number, width: number, totalHeight: number, barHeight: number): void {
  const step = SEGMENT_HEIGHT + SEGMENT_GAP;
  for (let y = totalHeight; y > totalHeight - barHeight; y -= step) {
    ctx.fillRect(x, y - SEGMENT_HEIGHT, width, SEGMENT_HEIGHT);
  }
}


export function animateBars(surface: Surface, ctx: CanvasRenderingContext2D, dataArray: Uint8Array, bufferLength: number, palette: WaveformPalette): void {
  const HEIGHT = surface.height;
  const barWidth = Math.ceil(surface.width / bufferLength) * 6;
  let x = 0;

  ctx.fillStyle = palette.outline;
  for (let i = 0; i < bufferLength; i++) {
    if (x > surface.width) break; // remaining bars are off-screen; skip the wasted draws
    const barHeight = (dataArray[i] / 255) * HEIGHT;

    drawSegmentedBar(ctx, x, barWidth, HEIGHT, barHeight);
    x += barWidth + 1;
  }
}

/** The simulated wave's shape at `x`: three stacked sines whose pitch drifts across the panel. */
function simulatedSample(x: number, width: number): number {
  const pos = x / width;
  const frequency = 0.1 + Math.sin(pos * Math.PI) * 0.05;
  return Math.sin(x * frequency) * 0.7 + Math.sin(x * frequency * 2.7) * 0.2 + Math.sin(x * frequency * 5.1) * 0.1;
}

/** Louder near the playhead, never below 10 %. */
function simulatedEnvelope(x: number, width: number, progress: number): number {
  return Math.max(0.1, 1 - Math.abs(x / width - progress) * 2);
}


export function drawSimulatedWaveform(
  ctx: CanvasRenderingContext2D,
  surface: Surface,
  palette: WaveformPalette,
  currentTime: number,
  duration: number,
  viewMode: string,
): void {
  const { width, height } = surface;
  const progress = duration > 0 ? currentTime / duration : 0;
  const centerY = height / 2;

  if (viewMode === 'line') {
    ctx.translate(0, centerY);
    ctx.strokeStyle = palette.outline;
    ctx.lineWidth = 3;
    ctx.beginPath();
    const ampScale = height * 0.35;
    for (let x = 0; x < width; x++) {
      const y = -simulatedSample(x, width) * simulatedEnvelope(x, width, progress) * ampScale;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(width, 0);
    ctx.stroke();
  } else if (viewMode === 'filled') {
    const points: Array<{ x: number; y: number }> = [];
    ctx.beginPath();
    ctx.moveTo(0, height);

    for (let x = 0; x < width; x++) {
      const y = centerY - simulatedSample(x, width) * simulatedEnvelope(x, width, progress) * height * 0.35;
      points.push({ x, y });
      ctx.lineTo(x, y);
    }

    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = palette.fill;
    ctx.fill();
    ctx.strokeStyle = palette.outline;
    ctx.lineWidth = 3;
    ctx.stroke();


    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = palette.midline;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const midY = points[i].y * 0.3 + centerY * 0.7;
      ctx.lineTo(points[i].x, midY);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  } else {

    const barCount = 28;
    const barWidth = width / barCount;
    ctx.fillStyle = palette.outline;
    for (let i = 0; i < barCount; i++) {
      // Simulated amplitude from the bar's frequency and the playback position
      const freq = i / barCount;
      const distFromCenter = Math.abs(freq - progress);
      const amp = Math.max(0.05, 1 - distFromCenter * 3) *
                 (0.3 + 0.7 * Math.abs(Math.sin(currentTime * (1 + freq * 3))));
      drawSegmentedBar(ctx, i * barWidth, barWidth - 1, height, amp * height);
    }
  }
}
