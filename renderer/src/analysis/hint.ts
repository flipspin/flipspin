import { msg } from '../i18n';
import { analysisDisplay, type AnalysisTrack } from './display'
import { confidenceLine } from './calibration'

export function analysisHint(track: AnalysisTrack, field: 'key' | 'bpm') {
  const state = analysisDisplay(track, field)
  const source = state.source === 'fixed' || state.source === 'tag' || state.source === 'computed' ? state.source : state.muted ? 'computed' : null
  const label = source === 'fixed' ? msg("Corrected by hand") : source === 'tag' ? msg("File tag") : state.muted ? msg("Flipspin's estimate_full") : msg("Flipspin's calculation_noun")
  return { source, label, line: !state.missing && source === 'computed' ? confidenceLine(field, track[`${field}Confidence`]) : null }
}

