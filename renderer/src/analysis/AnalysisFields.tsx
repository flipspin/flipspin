import { useId, useLayoutEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { apiGet, isApiError, serverDetail } from '../data'
import { analysisKeys } from './data'
import { KEY_OPTIONS, keyCode } from './keys'
import { Missing } from '../ui/react/components/Missing'
import Select from '../ui/components/Select'
import { AnalysisTooltip } from './AnalysisTooltip'
import { AnalysisValue } from './AnalysisValue'
import { AnalysisSource } from './AnalysisSource'
import { confidenceLine } from './calibration'
import { openSettings } from '../shell/ServerBadge'
import { closeTrackInfo } from '../library/tracks/trackInfoStore'
import { ConfirmEstimate, useAnalysisConfirmation } from './confirmation'
import { BpmScale } from './BpmScale'
import './analysis.css'

/** Corrections save per field, for every format; revisions prevent lost updates. */
export function AnalysisFields({ relPath, onChanged, inPlace = false }: { relPath: string; onChanged?: () => void; inPlace?: boolean }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const query = useQuery({ queryKey: analysisKeys.track(relPath), queryFn: ({ signal }) => apiGet('/api/analysis/{relPath}', { params: { path: { relPath } }, signal }) })
  const [message, setMessage] = useState('')
  const [bpmDraft, setBpmDraft] = useState<string | null>(null)
  const [editingBpm, setEditingBpm] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const focusKey = useRef(false)
  const id = useId()
  const { busy, save: saveFixed, scaleBpm } = useAnalysisConfirmation({
    onConflict: () => setMessage(t("The value changed on the nest. The latest version was loaded.")),
    onError: error => {
      const body = isApiError(error) ? error.body : null
      const detail = body && typeof body === 'object' && 'detail' in body ? body.detail : null
      const validation = Array.isArray(detail) ? detail.map(item => item.msg).filter(Boolean).join(' · ') : null
      setMessage(serverDetail(error) || validation || (isApiError(error) ? error.userMessage : t("Could not save the change")))
    },
  })
  const data = query.data
  useLayoutEffect(() => {
    if (!focusKey.current || busy) return
    focusKey.current = false
    root.current?.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]')?.focus({ preventScroll: true })
  }, [busy, data])
  const changed = () => {
    setBpmDraft(null)
    void client.invalidateQueries({ queryKey: analysisKeys.estimates })
    onChanged?.()
  }
  const save = async (field: 'key' | 'bpm', value: string | number | null) => {
    if (!data || busy) return
    setMessage('')
    await saveFixed(relPath, data.rev, field, value, changed)
  }
  if (!data) return <div role={query.isError ? 'alert' : 'status'}><Missing kind={query.isError ? 'unavailable' : 'loading'} />{query.isError ? <button type="button" className="k-btn k-btn--text" onClick={() => void query.refetch()}>{t("Retry")}</button> : null}</div>
  const automatic = (field: 'key' | 'bpm', value: string | number | null) => value == null ? t("Not analyzed") : field === 'key' ? keyCode(String(value)) : String(value)
  const track = { keyConfidence: data.keyConfidence, bpmConfidence: data.bpmConfidence, key: data.key.value, keyEstimated: data.key.estimated, keySource: data.key.source, bpm: data.bpm.value, bpmEstimated: data.bpm.estimated, bpmSource: data.bpm.source }
  const keyAutomatic = data.fixed.key == null
  const bpmEstimated = data.fixed.bpm == null && data.bpm.estimated
  const showBpmEstimate = bpmEstimated && !editingBpm && bpmDraft == null
  const options = [
    { value: '', label: t("Automatic"), hint: `${(data.computed.keyEstimated ?? (data.key.estimated && keyAutomatic)) ? '≈ ' : ''}${automatic('key', data.computed.key)}`, pinned: true },
    ...['A', 'B'].flatMap(ring => KEY_OPTIONS.filter(key => key.value.endsWith(ring)).map(key => ({ ...key, label: `${key.value} · ${t(key.name)}`, group: t(ring === 'A' ? "Minor" : "Major"), emphasized: data.computed.key != null && key.value === keyCode(String(data.computed.key)) }))),
  ]
  const confidence = (field: 'key' | 'bpm') => track[`${field}Source`] === 'computed' && confidenceLine(field, data[`${field}Confidence`]) ? <span className="analysis-confidence-line">{confidenceLine(field, data[`${field}Confidence`])} · <a href="#/ajustes" onClick={event => { event.preventDefault(); closeTrackInfo(); openSettings('accuracy') }}>{t("Accuracy")}</a></span> : null
  return <div ref={root} className={inPlace ? "song-analysis" : undefined}>
    <div className="analysis-fields" aria-busy={busy}>
      <div className="analysis-field"><label htmlFor={`${id}-key`}>{t("Key_tone")}</label>
        <Select id={`${id}-key`} className="analysis-key-select" ariaLabel={t("Key_tone")} value={keyAutomatic ? '' : keyCode(String(data.fixed.key))} options={options} searchAbove={Infinity} disabled={busy}
          display={<span className="analysis-key-display">{keyAutomatic && !inPlace ? <span>{t("Automatic")}</span> : null}<AnalysisValue track={track} field="key" sheet={inPlace} /></span>}
          onChange={value => { focusKey.current = true; void save('key', value || null) }} />
        {inPlace && data.key.estimated && data.computed.key != null ? <ConfirmEstimate field="key" value={data.computed.key} disabled={busy} onConfirm={() => { focusKey.current = true; void save('key', data.computed.key) }} /> : null}
        {inPlace ? confidence('key') : null}
      </div>
      <div className="analysis-field"><label htmlFor={`${id}-bpm`}>BPM</label>
        <AnalysisTooltip track={track} field="bpm" className="analysis-bpm-tooltip"><div className="analysis-bpm-field">
          <input id={`${id}-bpm`} className={`k-field${showBpmEstimate ? ' analysis-bpm-input--estimated' : ''}`} type="number" min={20} max={300} step="any" disabled={busy} value={bpmDraft ?? data.bpm.value ?? ''}
            aria-describedby={showBpmEstimate ? `${id}-estimate` : undefined}
            onFocus={() => setEditingBpm(true)} onChange={event => setBpmDraft(event.target.value)}
            onBlur={() => { setEditingBpm(false); if (bpmDraft !== null && bpmDraft !== String(data.bpm.value ?? '')) void save('bpm', bpmDraft === '' ? null : Number(bpmDraft)); else setBpmDraft(null) }}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }} />
          {showBpmEstimate ? <><span className="analysis-bpm-estimate" aria-hidden><span className="analysis-value analysis-value--estimated">≈ {data.bpm.value}</span></span><span id={`${id}-estimate`} className="k-sr-only">{t("Flipspin's estimate")}</span></> : null}
          <span className="analysis-bpm-unit">{inPlace && !bpmEstimated ? <AnalysisSource track={track} field="bpm" /> : <span aria-hidden>BPM</span>}</span>
        </div></AnalysisTooltip>
        <div className="analysis-bpm-actions">
          {data.fixed.bpm != null ? <button type="button" className="k-btn k-btn--text analysis-reset" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => { setBpmDraft(null); void save('bpm', null) }}>{t("Use automatic · {{value}}", { value: automatic('bpm', data.computed.bpm) })}</button>
            : bpmEstimated && data.computed.bpm != null ? <button type="button" className="k-btn k-btn--text analysis-reset" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => void save('bpm', data.computed.bpm)}>{t("Confirm {{value}}", { value: data.computed.bpm })}</button> : null}
          <BpmScale bpm={bpmDraft === null ? data.bpm.value : bpmDraft === '' ? null : Number(bpmDraft)} disabled={busy} onScale={(value, factor) => { setMessage(''); void scaleBpm(relPath, data.rev, value, factor, data.fixed.bpm, changed) }} />
        </div>
        {inPlace ? confidence('bpm') : null}
      </div>
    </div>
    {message ? <p role="alert">{message}</p> : null}
  </div>
}
