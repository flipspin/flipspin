import { describe, expect, it } from 'vitest';
import { findSpectralPeaks, formatHz, fracAtFreq, freqAtFrac } from './spectrumDraw';

describe('spectrumDraw helpers', () => {
  it('formats Hz with a k above 1000', () => {
    expect(formatHz(440.4)).toBe('440');
    expect(formatHz(1234)).toBe('1.2k');
    expect(formatHz(10000)).toBe('10k');
  });

  it('maps a fraction to a log frequency and back', () => {
    expect(freqAtFrac(0, 30, 20000)).toBeCloseTo(30);
    expect(freqAtFrac(1, 30, 20000)).toBeCloseTo(20000);
    expect(freqAtFrac(0.5, 100, 10000)).toBeCloseTo(1000);
    for (const f of [50, 440, 5000]) expect(freqAtFrac(fracAtFreq(f, 30, 20000), 30, 20000)).toBeCloseTo(f);
  });

  it('returns the k loudest local maxima over the threshold, sorted by bin', () => {
    //            0  1  2   3   4  5   6  7   8   9  10
    const data = [0, 0, 0, 90, 10, 0, 60, 0, 120, 0, 0];
    expect(findSpectralPeaks(data, data.length, 2, 40)).toEqual([{ bin: 3, mag: 90 }, { bin: 8, mag: 120 }]);
    expect(findSpectralPeaks(data, data.length, 5, 70)).toEqual([{ bin: 3, mag: 90 }, { bin: 8, mag: 120 }]);
    expect(findSpectralPeaks(data, data.length, 5, 200)).toEqual([]);
  });

  it('never counts a plateau twice', () => {
    const data = [0, 0, 0, 80, 80, 0, 0];
    expect(findSpectralPeaks(data, data.length, 5, 40)).toEqual([{ bin: 4, mag: 80 }]);
  });
});
