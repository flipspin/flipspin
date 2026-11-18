// Share origin and scale between the generating curve and its y projection
// so a point and its waveform sample align horizontally.

export const TAU = 2 * Math.PI;

export interface Point {
  x: number;
  y: number;
}

export interface Generator {
  id: GeneratorId;
  /** Wave name; for tests and logs; the picker shows only the formula. */
  name: string;
  /** y(θ) as an expression in θ. The picker's only label; nothing is written on the figure. */
  formula: string;
  /**
   * Point on the curve at parameter θ, 2π-periodic, inside [-1, 1]². The wave
   * value at θ is `point(θ).y`.
   */
  point(theta: number): Point;
  /**
   * θ is the point's polar angle, so the figure may draw it as an arc at the
   * origin. True only for the circle: on the polygons θ is arc length (see
   * below) and on the heart and the Lissajous figure it is a bare parameter.
   */
  polar: boolean;
}

export type GeneratorId = 'circle' | 'diamond' | 'square' | 'segment' | 'lissajous' | 'heart';

/** θ reduced to [0, 2π). */
export function wrapAngle(theta: number): number {
  return ((theta % TAU) + TAU) % TAU;
}

// Traverse polygon edges at constant speed so their y projection forms a triangle wave.
// A rotating ray instead produces a piecewise rational curve.
function diamondPoint(theta: number): Point {
  const u = wrapAngle(theta) / (TAU / 4); // [0, 4): one unit per side
  const side = Math.floor(u);
  const s = u - side;
  switch (side) {
    case 0: return { x: 1 - s, y: s };       // (1,0)  → (0,1)
    case 1: return { x: -s, y: 1 - s };      // (0,1)  → (-1,0)
    case 2: return { x: s - 1, y: -s };      // (-1,0) → (0,-1)
    default: return { x: s, y: s - 1 };      // (0,-1) → (1,0)
  }
}

function squarePoint(theta: number): Point {
  const u = wrapAngle(theta) / (TAU / 8); // [0, 8): perimeter is 8
  if (u < 1) return { x: 1, y: u };         // (1,0)  → (1,1)
  if (u < 3) return { x: 2 - u, y: 1 };     // (1,1)  → (-1,1)
  if (u < 5) return { x: -1, y: 4 - u };    // (-1,1) → (-1,-1)
  if (u < 7) return { x: u - 6, y: -1 };    // (-1,-1)→ (1,-1)
  return { x: 1, y: u - 8 };                // (1,-1) → (1,0)
}

// Normalize both heart-curve axes by 16 to retain proportions, then center its full y range
// from -17 to approximately 11.923; the cleft at y=5 is not the maximum.
const HEART_Y_MIN = -17;
const HEART_Y_MAX = 11.92325240904141;
const HEART_Y_MID = (HEART_Y_MIN + HEART_Y_MAX) / 2;
export const HEART_Y_HALF_SPAN = (HEART_Y_MAX - HEART_Y_MIN) / 2 / 16;
function heartPoint(theta: number): Point {
  const s = Math.sin(theta);
  const y = 13 * Math.cos(theta) - 5 * Math.cos(2 * theta) - 2 * Math.cos(3 * theta) - Math.cos(4 * theta);
  return { x: s * s * s, y: (y - HEART_Y_MID) / 16 };
}

export const GENERATORS: readonly Generator[] = [
  {
    id: 'heart',
    name: 'Corazón',
    formula: '(13 cos θ − 5 cos 2θ − 2 cos 3θ − cos 4θ + 2.54) / 16',
    point: heartPoint,
    polar: false,
  },
  {
    id: 'circle',
    name: 'Seno',
    formula: 'sin θ',
    point: (t) => ({ x: Math.cos(t), y: Math.sin(t) }),
    polar: true,
  },
  {
    id: 'diamond',
    name: 'Triangular',
    formula: '(2/π) · arcsin(sin θ)',
    point: diamondPoint,
    polar: false,
  },
  {
    id: 'square',
    name: 'Trapezoidal',
    formula: 'sat((4/π) · arcsin(sin θ))',
    point: squarePoint,
    polar: false,
  },
  {
    id: 'segment',
    name: 'Diente de sierra',
    formula: '(θ mod 2π) / π − 1',
    point: (t) => ({ x: 0, y: wrapAngle(t) / Math.PI - 1 }),
    polar: false,
  },
  {
    id: 'lissajous',
    name: 'Lissajous 1:2',
    formula: 'sin 2θ',
    point: (t) => ({ x: Math.sin(t), y: Math.sin(2 * t) }),
    polar: false,
  },
];

export const DEFAULT_GENERATOR: GeneratorId = 'heart';

export function getGenerator(id: string): Generator {
  return GENERATORS.find((g) => g.id === id) ?? GENERATORS[0];
}

export interface OscilloscopeColors {
  /** The generating curve and the moving point's outline. */
  ink: string;
  /** Axes, ticks, labels, the projection line. */
  muted: string;
  /** The trace, the radius vector, the moving point. */
  accent: string;
}

// Vertical budget: the mode pills float over the top-left corner (top 8 px,
// 28 px tall), so the figure starts below them. No text is drawn anywhere —
// the graduations are hairlines only; the equations live in the picker.
const HEADER = 40;
const FOOTER = 10;
const PAD = 12;
/** A change in y (curve units, so ±1 is full scale) larger than this between adjacent samples is a discontinuity, and the trace breaks. */
const JUMP = 1;

/** How many whole periods the wave plot shows for a given width: ≥ 360 px each, at most three. */
export function periodsFor(plotWidth: number): number {
  return Math.min(3, Math.max(1, Math.floor(plotWidth / 360)));
}

/** A sample of a curve: where to draw it, and the curve's own y for detecting jumps. */
interface Sample extends Point {
  value: number;
}

/** Strokes a sampled path, breaking it wherever the curve's y jumps (the sawtooth's flyback). */
function tracePath(
  ctx: CanvasRenderingContext2D,
  samples: number,
  at: (i: number) => Sample,
): void {
  ctx.beginPath();
  let prev: Sample | null = null;
  for (let i = 0; i <= samples; i++) {
    const p = at(i);
    if (prev && Math.abs(p.value - prev.value) <= JUMP) ctx.lineTo(p.x, p.y);
    else ctx.moveTo(p.x, p.y);
    prev = p;
  }
  ctx.stroke();
}

function dot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke?: string): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/**
 * Draws the whole figure in CSS pixels; the caller owns the DPR transform.
 * `theta` grows without bound (ω·t); the point wraps around the plotted domain.
 */
export function drawIdleOscilloscope(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  theta: number,
  gen: Generator,
  colors: OscilloscopeColors,
): void {
  const top = HEADER;
  const bottom = height - FOOTER;
  const oy = (top + bottom) / 2;
  const R = Math.max(8, (bottom - top) / 2 - 6);      // 1 unit of y, in px
  const axisReach = R * 1.15;
  const ox = PAD + axisReach + 4;                     // generator origin
  const x0 = ox + axisReach + 24;                     // wave plot's y-axis
  const x1 = width - PAD;
  const plotW = x1 - x0;
  if (plotW < 40) return;

  const periods = periodsFor(plotW);
  const domain = TAU * periods;
  const pxPerRad = plotW / domain;
  const phi = ((theta % domain) + domain) % domain;   // where the point is, inside the domain
  const p = gen.point(phi);
  const px = ox + p.x * R;
  const py = oy - p.y * R;                            // == the trace's y at φ, by construction
  const tx = x0 + phi * pxPerRad;

  ctx.save();
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';

  // ── wave plot: graduations, axes ─────────────────────────────────────────
  const quarterPx = pxPerRad * (Math.PI / 2);         // graduated every π/2
  ctx.strokeStyle = colors.muted;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.28;
  ctx.beginPath();
  for (let i = 1; i <= 4 * periods; i++) {
    const x = x0 + i * quarterPx;
    ctx.moveTo(x, oy - R);
    ctx.lineTo(x, oy + R);
  }
  ctx.moveTo(x0, oy - R); ctx.lineTo(x1, oy - R);
  ctx.moveTo(x0, oy + R); ctx.lineTo(x1, oy + R);
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.beginPath();
  ctx.moveTo(x0, oy); ctx.lineTo(x1, oy);             // θ axis
  ctx.moveTo(x0, oy - R - 4); ctx.lineTo(x0, oy + R + 4); // y axis
  for (let i = 0; i <= 4 * periods; i++) {
    const x = x0 + i * quarterPx;
    ctx.moveTo(x, oy); ctx.lineTo(x, oy + 3);
  }
  ctx.moveTo(x0 - 3, oy - R); ctx.lineTo(x0, oy - R);
  ctx.moveTo(x0 - 3, oy + R); ctx.lineTo(x0, oy + R);
  ctx.stroke();

  // ── the trace, one sample per pixel ──────────────────────────────────────
  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 2;
  const samples = Math.ceil(plotW);
  tracePath(ctx, samples, (i) => {
    const x = x0 + (i / samples) * plotW;
    const value = gen.point((x - x0) / pxPerRad).y;
    return { x, y: oy - value * R, value };
  });

  // ── generator: axes, curve, radius, angle ────────────────────────────────
  ctx.strokeStyle = colors.muted;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(ox - axisReach, oy); ctx.lineTo(ox + axisReach, oy);
  ctx.moveTo(ox, oy - axisReach); ctx.lineTo(ox, oy + axisReach);
  for (const s of [-1, 1]) {
    ctx.moveTo(ox + s * R, oy - 3); ctx.lineTo(ox + s * R, oy + 3);
    ctx.moveTo(ox - 3, oy + s * R); ctx.lineTo(ox + 3, oy + s * R);
  }
  ctx.stroke();

  ctx.strokeStyle = colors.ink;
  ctx.lineWidth = 1.5;
  const CURVE_SAMPLES = 512;                          // divisible by 4: polygon corners land on samples
  tracePath(ctx, CURVE_SAMPLES, (i) => {
    const q = gen.point((i / CURVE_SAMPLES) * TAU);
    return { x: ox + q.x * R, y: oy - q.y * R, value: q.y };
  });

  if (gen.polar) {
    const angle = wrapAngle(phi);
    const arcR = R * 0.3;
    ctx.strokeStyle = colors.muted;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(ox, oy, arcR, 0, -angle, true);           // canvas y points down: counter-clockwise on screen
    ctx.stroke();
  }

  ctx.strokeStyle = colors.accent;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(ox, oy);
  ctx.lineTo(px, py);
  ctx.stroke();

  // ── the projection: point → trace, horizontal because they share oy and R ─
  ctx.strokeStyle = colors.muted;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(tx, py);
  ctx.stroke();
  ctx.setLineDash([]);

  dot(ctx, ox, oy, 2, colors.ink);
  dot(ctx, px, py, 3.5, colors.accent, colors.ink);
  dot(ctx, tx, py, 3.5, colors.accent, colors.ink);

  ctx.restore();
}
