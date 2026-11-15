export const STEMS = ['drums', 'bass', 'other', 'vocals'] as const;
export type Stem = typeof STEMS[number];
// Storage and presets remain linear gain percent (20 is still about −14 dB).
export const MAX_LEVEL = 200;
export const clampLevel = (level: number) => Math.max(0, Math.min(MAX_LEVEL, level));
export const UNITY_POSITION = (192 / 198) ** 8;
export const gainToDb = (gain: number) => gain <= 0 ? -Infinity : 20 * Math.log10(gain);
export const dbToGain = (db: number) => db === -Infinity ? 0 : 10 ** (db / 20);
export const positionToGain = (p: number) => p <= 0 ? 0 : p >= 1 ? 2 : 2 ** ((198 * p ** (1 / 8) - 192) / 6);
export const gainToPosition = (gain: number) => gain <= 0 ? 0 : Math.max(0, Math.min(1, (Math.max(0, (6 * Math.log2(gain) + 192) / 198)) ** 8));
export const positionToDb = (p: number) => gainToDb(positionToGain(p));
export const dbToPosition = (db: number) => gainToPosition(dbToGain(db));
export function formatDb(db: number) {
  if (db === -Infinity) return '−∞';
  const rounded = Math.round(Math.abs(db) * 10) / 10;
  return `${rounded === 0 ? '' : db < 0 ? '−' : '+'}${rounded.toFixed(1)} dB`;
}
export interface Mix {
  readonly levels: Readonly<Record<Stem, number>>;
  readonly muted: ReadonlySet<Stem>;
  readonly solo: ReadonlySet<Stem>;
}
export const originalMix = (): Mix => ({ levels: { drums: 100, bass: 100, other: 100, vocals: 100 }, muted: new Set(), solo: new Set() });
export const effectiveGain = (mix: Mix, stem: Stem) => mix.muted.has(stem) || (mix.solo.size > 0 && !mix.solo.has(stem)) ? 0 : mix.levels[stem] / 100;
// Judged by what is heard: all four soloed at 0 dB is the original song, and must not route every song through stems.
export const isOriginal = (mix: Mix) => STEMS.every(stem => effectiveGain(mix, stem) === 1);
export function loadMix(): Mix {
  try {
    const raw = JSON.parse(localStorage.getItem('krobi.mix') || 'null');
    if (!raw) return originalMix();
    const mix = originalMix();
    const levels = { ...mix.levels };
    for (const stem of STEMS) {
      const value = raw.levels?.[stem];
      if (typeof value === 'number' && Number.isFinite(value)) levels[stem] = clampLevel(value);
    }
    const readSet = (value: unknown): Set<Stem> => new Set(Array.isArray(value) ? value.filter((stem): stem is Stem => STEMS.includes(stem)) : []);
    return { levels, muted: readSet(raw.muted), solo: readSet(raw.solo) };
  } catch { return originalMix(); }
}
export function saveMix(mix: Mix) {
  try {
    if (isOriginal(mix)) localStorage.removeItem('krobi.mix');
    else localStorage.setItem('krobi.mix', JSON.stringify({ levels: mix.levels, muted: [...mix.muted], solo: [...mix.solo] }));
  } catch { /* A denied storage write must never interrupt playback. */ }
}

export const FADER_TICKS = [-Infinity, -20, -10, -6, 0, 6].map(db => ({
  db, position: dbToPosition(db), label: db === -Infinity ? '−∞' : db < 0 ? `−${-db}` : db > 0 ? `+${db}` : '0',
}));
