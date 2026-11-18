import { afterEach, describe, expect, it } from 'vitest';
import { IDLE_WAVE_TYPES, loadChoice, saveChoice, VIEW_MODES } from './waveformChoices';

afterEach(() => localStorage.clear());

describe('waveformChoices', () => {
  it('remembers a picked mode', () => {
    saveChoice('k', 'bars');
    expect(loadChoice('k', VIEW_MODES, 'line')).toBe('bars');
  });

  it('falls back when nothing is stored or the stored id no longer exists', () => {
    expect(loadChoice('k', VIEW_MODES, 'line')).toBe('line');
    localStorage.setItem('k', 'oscilloscope');
    expect(loadChoice('k', VIEW_MODES, 'line')).toBe('line');
  });

  it('offers every idle generator by its formula', () => {
    expect(IDLE_WAVE_TYPES.find((o) => o.id === 'circle')?.label).toBe('sin θ');
  });
});
