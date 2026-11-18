import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip } from '../ui/react/components/Tooltip'
import type { AnalysisTrack } from './display'
import { analysisHint } from './hint'

export function AnalysisTooltip({ track, field, className, children }: { track: AnalysisTrack; field: 'key' | 'bpm'; className?: string; children: ReactNode }) {
  const { t } = useTranslation()
  const hint = analysisHint(track, field)
  const label = t(hint.label)
  return hint.source ? <Tooltip className={className} label={`${label}${hint.line ? ` · ${hint.line}` : ''}`} content={<><b>{label}</b>{hint.line ? <code>{hint.line}</code> : null}</>}>{children}</Tooltip> : <span className={className}>{children}</span>
}
