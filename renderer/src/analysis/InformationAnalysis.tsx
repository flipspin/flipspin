import { Fragment, useLayoutEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { apiGet, useCurrentUser } from '../data'
import { analysisKeys } from './data'
import { AnalysisValue } from './AnalysisValue'
import type { AnalysisTrack } from './display'
import { ConfirmEstimate, useAnalysisConfirmation } from './confirmation'
import { confidenceLine } from './calibration'
import { openSettings } from '../shell/ServerBadge'
import { closeTrackInfo } from '../library/tracks/trackInfoStore'
import { BpmScale } from './BpmScale'

export function InformationAnalysis({ relPath, track, readOnly = false }: { relPath: string | null; track: AnalysisTrack; readOnly?: boolean }) {
  const { t } = useTranslation()
  const me = useCurrentUser()
  const client = useQueryClient()
  const query = useQuery({ queryKey: analysisKeys.track(relPath ?? ''), queryFn: ({ signal }) => apiGet('/api/analysis/{relPath}', { params: { path: { relPath: relPath! } }, signal }), enabled: !!relPath })
  const { busy, save, scaleBpm, message } = useAnalysisConfirmation()
  const root = useRef<HTMLDivElement>(null)
  const focus = useRef(false)
  useLayoutEffect(() => {
    if (!focus.current || busy) return
    focus.current = false
    const dialog = root.current?.closest('[role="dialog"]')
    const next = root.current?.querySelector<HTMLButtonElement>('[data-confirm]:not(:disabled)') ?? dialog?.querySelector<HTMLElement>('button, input, select, [tabindex="0"]')
    next?.focus()
  }, [busy, query.data])
  const data = query.data
  const effective = data ? { keyConfidence: data.keyConfidence, bpmConfidence: data.bpmConfidence, key: data.key.value, bpm: data.bpm.value, keyEstimated: data.key.estimated, bpmEstimated: data.bpm.estimated, keySource: data.key.source, bpmSource: data.bpm.source, analysisState: data.state } : track
  return <div ref={root} className="information-analysis">
    {(['key', 'bpm'] as const).map(field => <Fragment key={field}>
      <dt>{field === 'key' ? t("Key_tone") : 'BPM'}</dt><dd><span className="analysis-line"><AnalysisValue track={effective} field={field} sheet />
        {!readOnly && me.data?.isOwner && relPath && data?.[field].estimated && data.computed[field] != null ? <ConfirmEstimate field={field} value={data.computed[field]} disabled={busy} onConfirm={() => { focus.current = true; void save(relPath, data.rev, field, data.computed[field], () => { void client.invalidateQueries({ queryKey: analysisKeys.estimates }) }) }} /> : null}
        {!readOnly && field === 'bpm' && relPath && data ? <BpmScale bpm={effective.bpm} disabled={busy} onScale={(value, factor) => { void scaleBpm(relPath, data.rev, value, factor, data.fixed.bpm, () => { void client.invalidateQueries({ queryKey: analysisKeys.estimates }) }) }} /> : null}
      </span>{effective[`${field}Source`] === 'computed' && confidenceLine(field, effective[`${field}Confidence`]) ? <span className="analysis-confidence-line">{confidenceLine(field, effective[`${field}Confidence`])} · <a href="#/ajustes" onClick={event => { event.preventDefault(); closeTrackInfo(); openSettings('accuracy') }}>{t("Accuracy")}</a></span> : null}</dd>
    </Fragment>)}
    {message ? <dd className="information-analysis__error" role="alert">{message}</dd> : null}
  </div>
}
