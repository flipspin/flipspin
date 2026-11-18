import { describe, expect, it } from 'vitest';
import { isOriginal, originalMix, STEMS } from './mix';

describe('isOriginal is judged by what is heard', () => {
  it('all four soloed at 0 dB is the original song', () => {
    expect(isOriginal({ ...originalMix(), solo: new Set(STEMS) })).toBe(true);
  });
  it('three soloed, one muted, or one moved fader is a mix', () => {
    expect(isOriginal({ ...originalMix(), solo: new Set(['drums', 'bass', 'other'] as const) })).toBe(false);
    expect(isOriginal({ ...originalMix(), muted: new Set(['vocals'] as const) })).toBe(false);
    expect(isOriginal({ ...originalMix(), levels: { ...originalMix().levels, vocals: 20 } })).toBe(false);
  });
});
