import { msg } from '../i18n';
/** The listing already resolves correction > file tag > computed per field. */
export type AnalysisTrack = {
  bpm?: unknown; key?: unknown; bpmEstimated?: unknown; keyEstimated?: unknown
  bpmConfidence?: unknown; keyConfidence?: unknown; bpmSource?: unknown; keySource?: unknown; bpmFixed?: unknown; keyFixed?: unknown; analysisState?: unknown; analysis?: unknown
}
export function analysisDisplay(track: AnalysisTrack, field: 'key' | 'bpm', _sheet = false) {
  const raw = track[field]
  const value = field === 'bpm' ? typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null : typeof raw === 'string' && raw.trim() ? raw : null
  const fixed = track[field === 'key' ? 'keyFixed' : 'bpmFixed'] === true || track[field === 'key' ? 'keySource' : 'bpmSource'] === 'fixed'
  const muted = value !== null && !fixed && track[field === 'key' ? 'keyEstimated' : 'bpmEstimated'] === true
  const analysis = track.analysis && typeof track.analysis === 'object' ? track.analysis as Record<string, unknown> : {}
  const reason = track.analysisState === 'failed' ? typeof analysis.error === 'string' ? analysis.error : msg("Could not analyze this song") : undefined
  return { value, muted, source: fixed ? 'fixed' : track[field === 'key' ? 'keySource' : 'bpmSource'], pencil: value !== null && fixed, missing: value === null, reason }
}
