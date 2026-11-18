import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleDashed, Pencil } from 'lucide-react'
import { analysisDisplay, type AnalysisTrack } from './display'
import { keyCode, keyName } from './keys'
import './analysis.css'
import { AnalysisTooltip } from './AnalysisTooltip'
import { analysisHint } from './hint'

export function AnalysisValue({ track, field, sheet = false, unit = false, onOpenInfo }: { track: AnalysisTrack; field: 'key' | 'bpm'; sheet?: boolean; unit?: boolean; onOpenInfo?: () => void }) {
  const { t } = useTranslation()
  const state = analysisDisplay(track, field, sheet)
  if (state.missing) {
    // An icon, not a word: "not analysed yet" repeats on every row of a fresh library.
    const label = state.reason ? t(state.reason) : t("Not analysed yet")
    return <span className="analysis-missing" data-kind="unanalysed" role="img" aria-label={label} title={label}><CircleDashed size={13} aria-hidden /></span>
  }
  const name = field === 'key' ? t(keyName(String(state.value))) : String(state.value)
  const value = field === 'key' ? sheet ? `${keyCode(String(state.value))} · ${name}` : keyCode(String(state.value)) : unit ? t('{{bpm}} BPM', { bpm: state.value }) : state.value
  const hint = analysisHint(track, field)
  const { source } = hint
  const label = t(hint.label)
  const openLabel = t("Open song info · {{source}}", { source: label })
  const action = (contents: ReactNode) => onOpenInfo ? <button type="button" className="analysis-open-info" aria-label={openLabel}
    onClick={event => { event.stopPropagation(); onOpenInfo() }} onDoubleClick={event => event.stopPropagation()}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() }}>{contents}</button> : contents
  const number = <span className={`analysis-value${state.muted ? ' analysis-value--estimated' : ''}`}>{state.muted ? <span aria-hidden="true">≈ </span> : null}<span className="analysis-value__number">{value}</span>{state.muted ? <span className="k-sr-only">{t(", Flipspin's estimate")}</span> : null}</span>
  const mark = !state.muted && source ? <span className={`analysis-source analysis-source--${source}${source === 'fixed' ? ' analysis-pencil' : ''}`} role={onOpenInfo ? undefined : 'img'} aria-label={onOpenInfo ? undefined : label} aria-hidden={onOpenInfo ? true : undefined}>
    {source === 'fixed' ? <Pencil size={14} aria-hidden /> : source === 'computed' ? <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="10" cy="10" r="8" strokeDasharray="2 2" /><path d="M4 10c2-7 3 7 6 0s3 7 6 0" /></svg> : <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true"><path d="M2.5 3h8l7 7-7 7-8-8z" strokeDasharray="2 2" /><circle cx="6.5" cy="7" r="1" /></svg>}
  </span> : null
  const contents = <>{state.muted ? action(number) : number}{mark ? action(mark) : null}</>
  return <AnalysisTooltip track={track} field={field} className="analysis-cell">{contents}</AnalysisTooltip>
}
