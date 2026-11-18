import { useTranslation } from 'react-i18next'
import { Pencil } from 'lucide-react'
import { analysisHint } from './hint'
import type { AnalysisTrack } from './display'

export function AnalysisSource({ track, field }: { track: AnalysisTrack; field: 'key' | 'bpm' }) {
  const { t } = useTranslation()
  const hint = analysisHint(track, field)
  if (!hint.source) return null
  return <span className={`analysis-source analysis-source--${hint.source}${hint.source === 'fixed' ? ' analysis-pencil' : ''}`} role="img" aria-label={t(hint.label)}>
    {hint.source === 'fixed' ? <Pencil size={14} aria-hidden /> : hint.source === 'computed' ? <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="10" cy="10" r="8" strokeDasharray="2 2" /><path d="M4 10c2-7 3 7 6 0s3 7 6 0" /></svg> : <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true"><path d="M2.5 3h8l7 7-7 7-8-8z" strokeDasharray="2 2" /><circle cx="6.5" cy="7" r="1" /></svg>}
  </span>
}
