import giantsteps from './accuracy-data/giantsteps-summary.json'
import library from './accuracy-data/library-results.json'

/** Calibration changes require a version bump so stored results remain interpretable. */
export const accuracyData = { giantsteps, library } as const
export const calibration = {
  version: giantsteps.version,
  measured: giantsteps.measured,
  cutoffs: { key: giantsteps.cutoffs.key, bpm: giantsteps.cutoffs.bpm },
  key: giantsteps.key.calibration_exact,
  bpm: giantsteps.tempo.v2.calibration_acc1,
  bpmOctave: giantsteps.tempo.v2.calibration_acc2,
} as const
export type CalibrationBand = (typeof calibration.key)[number]

/** Lower edges are inclusive; shared edges choose the higher band. Rounded gaps
 * use the preceding band. Valid scores outside the measured sample clamp to the
 * end bands; absent, nonfinite and out-of-domain scores have no calibration. */
export function bandFor(bands: readonly CalibrationBand[], confidence: unknown): CalibrationBand | null {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || !bands.length) return null
  return [...bands].reverse().find(band => confidence >= band.conf_min) ?? bands[0]
}

export function confidenceLine(field: 'key' | 'bpm', confidence: unknown): string | null {
  const band = bandFor(calibration[field], confidence)
  if (!band) return null
  const score = (confidence as number).toFixed(field === 'key' ? 3 : 2)
  if (field === 'key') return `c = ${score} · ${Math.round(band.pct)} %`
  const octave = bandFor(calibration.bpmOctave, confidence)!
  return `p = ${score} · ${Math.round(band.pct)} % within ±4 % · ${Math.round(octave.pct)} % incl. ½/×2`
}
