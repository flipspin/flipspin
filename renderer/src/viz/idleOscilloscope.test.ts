import { describe, expect, it } from 'vitest';
import {
  GENERATORS,
  HEART_Y_HALF_SPAN,
  TAU,
  getGenerator,
  periodsFor,
  wrapAngle,
} from './idleOscilloscope';

const EPS = 1e-9;
const sample = (n: number) => Array.from({ length: n }, (_, i) => (i / n) * TAU);

// Closed forms the figure's header claims for each wave.
const triangle = (t: number) => (2 / Math.PI) * Math.asin(Math.sin(t));
const trapezoid = (t: number) => Math.max(-1, Math.min(1, (4 / Math.PI) * Math.asin(Math.sin(t))));
const sawtooth = (t: number) => wrapAngle(t) / Math.PI - 1;

describe('generators', () => {
  it.each(GENERATORS)('$id is 2π-periodic and stays inside the unit square', (gen) => {
    for (const t of sample(97)) {
      const a = gen.point(t);
      const b = gen.point(t + TAU);
      const c = gen.point(t - 3 * TAU);
      expect(a.x).toBeCloseTo(b.x, 9);
      expect(a.y).toBeCloseTo(b.y, 9);
      expect(a.y).toBeCloseTo(c.y, 9);
      expect(Math.abs(a.x)).toBeLessThanOrEqual(1 + EPS);
      expect(Math.abs(a.y)).toBeLessThanOrEqual(1 + EPS);
    }
  });

  it('the diamond traversed at constant speed yields an exact triangle wave', () => {
    const gen = getGenerator('diamond');
    for (const t of sample(360)) {
      const p = gen.point(t);
      expect(p.y).toBeCloseTo(triangle(t), 9);
      expect(Math.abs(p.x) + Math.abs(p.y)).toBeCloseTo(1, 9); // the point really is on the rhombus
    }
  });

  it('the square traversed at constant speed yields an exact trapezoid wave', () => {
    const gen = getGenerator('square');
    for (const t of sample(360)) {
      const p = gen.point(t);
      expect(p.y).toBeCloseTo(trapezoid(t), 9);
      expect(Math.max(Math.abs(p.x), Math.abs(p.y))).toBeCloseTo(1, 9);
    }
    // Flat for a quarter turn at the top: the whole top side.
    expect(gen.point(Math.PI / 4).y).toBeCloseTo(1, 9);
    expect(gen.point((3 * Math.PI) / 4).y).toBeCloseTo(1, 9);
  });

  it('the segment yields a sawtooth with one flyback per turn', () => {
    const gen = getGenerator('segment');
    for (const t of sample(360)) {
      const p = gen.point(t);
      expect(p.x).toBe(0);
      expect(p.y).toBeCloseTo(sawtooth(t), 9);
    }
    expect(gen.point(0).y).toBeCloseTo(-1, 9);
    expect(gen.point(TAU - 1e-9).y).toBeCloseTo(1, 6);
  });

  it('the circle and the Lissajous figure are the classical ones', () => {
    expect(getGenerator('circle').point(Math.PI / 6).y).toBeCloseTo(0.5, 9);
    expect(getGenerator('lissajous').point(Math.PI / 4).y).toBeCloseTo(1, 9);
    expect(getGenerator('lissajous').point(Math.PI / 4).x).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it('the heart keeps its real proportions instead of being stretched to ±1', () => {
    const gen = getGenerator('heart');
    const ys = sample(3600).map((t) => gen.point(t).y);
    const xs = sample(3600).map((t) => gen.point(t).x);
    // MathWorld: x spans 32, y spans ≈ 28.9 → divided by 16, x is ±1 and y is ±0.904, centred.
    expect(Math.max(...xs)).toBeCloseTo(1, 6);
    expect(Math.min(...xs)).toBeCloseTo(-1, 6);
    expect(HEART_Y_HALF_SPAN).toBeCloseTo(0.9038516, 6);
    expect(Math.max(...ys)).toBeCloseTo(HEART_Y_HALF_SPAN, 5);
    expect(Math.min(...ys)).toBeCloseTo(-HEART_Y_HALF_SPAN, 5);
  });

  it('polar generators really have θ as their polar angle', () => {
    for (const gen of GENERATORS.filter((g) => g.polar)) {
      for (const t of sample(96)) {
        const p = gen.point(t);
        // atan2 of the point equals t, modulo 2π; the on-screen angle arc is truthful.
        expect(wrapAngle(Math.atan2(p.y, p.x))).toBeCloseTo(wrapAngle(t), 9);
      }
    }
  });

  it('falls back to the first generator for an unknown id', () => {
    expect(getGenerator('nope')).toBe(GENERATORS[0]);
  });
});

describe('axis helpers', () => {
  it('shows between one and three periods, at least 360 px each', () => {
    expect(periodsFor(100)).toBe(1);
    expect(periodsFor(800)).toBe(2);
    expect(periodsFor(5000)).toBe(3);
  });
});
