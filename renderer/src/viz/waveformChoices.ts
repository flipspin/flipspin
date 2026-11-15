import { msg } from '../i18n';
import { GENERATORS } from './idleOscilloscope';

export interface WaveformChoice {
  id: string;
  label: string;
}

export type ViewMode = 'filled' | 'line' | 'bars' | 'spectrum' | 'decomposer';

// Ids are persisted (see loadChoice), so rename one only with a fallback in mind. `msg` only
// marks them: the table is built once, so the render site translates each
// label with `t()` before handing the list to the dropdown.
export const VIEW_MODES: ReadonlyArray<{ id: ViewMode; label: string }> = [
  { id: 'filled', label: msg("Filled") },
  { id: 'line', label: msg("Line") },
  { id: 'bars', label: msg("Bars") },
  { id: 'spectrum', label: msg("Spectrum") },
  { id: 'decomposer', label: msg("Decompose_translated") },
];

// View modes that read the FFT magnitude spectrum (getByteFrequencyData) rather
// than the raw time-domain samples.
export const FREQUENCY_VIEW_MODES: ReadonlySet<string> = new Set(['bars', 'spectrum', 'decomposer']);

// Idle (no song, or paused): the picker chooses the generating curve of the
// figure in idleOscilloscope.ts. Same {id, label} shape as VIEW_MODES so the
// one dropdown serves both. The label is the bare expression; the open list
// shows it whole, the closed button clips it to a fixed width so choosing a
// long one does not move the "Analysis" button.
export const IDLE_WAVE_TYPES: readonly WaveformChoice[] = GENERATORS.map((g) => ({ id: g.id, label: g.formula }));
/** The idle figure turns at this angular speed: one period every ~6 s. */
export const IDLE_OMEGA = 1.05; // rad/s

// The last picked mode and idle curve survive a restart. One key per picker,
// shared by every instance (Waveform drawer, lyrics view): a choice is a
// preference, not per-surface state. A stored id that no longer exists falls
// back to the default rather than leaving the dropdown blank.
export const VIEW_MODE_KEY = 'krobi.ondaViewMode';
export const IDLE_WAVE_KEY = 'krobi.ondaIdleWave';

export function loadChoice<T extends string>(key: string, options: ReadonlyArray<{ id: T }>, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    const hit = v ? options.find((o) => o.id === v) : undefined;
    if (hit) return hit.id;
  } catch { /* localStorage unavailable — fall back to default */ }
  return fallback;
}

export function saveChoice(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* ignore persistence errors */ }
}
