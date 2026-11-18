import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { apiGet, apiPost, apiPut, isApiError, queryKeys } from '../../data'
import { useAnalysisSummary, analysisKeys } from '../../analysis/data'
import { accuracyData } from '../../analysis/calibration'
import { useAnalysisTags } from '../data'
import { useConfig } from '../config'
import { useSettings } from '../context'
import { QueryFailure, Skel, Switch, Word, useToast } from '../parts'
import { Missing } from '../../ui/react/components/Missing'
import { OutdatedStatus } from '../../analysis/OutdatedStatus'
import { RunsOn } from './RunsOn'
import './background-work.css'
import { computeKey, useCompute } from './data'

export function AnalysisControls() {
  const { t } = useTranslation()
  const { go } = useSettings()
  const { query: config, save, saving } = useConfig()
  const toast = useToast()
  const queryClient = useQueryClient()
  const summary = useAnalysisSummary(true)
  const computers = useCompute().data?.computers ?? []
  const tags = useAnalysisTags(true)
  const [mode, setMode] = useState<'outdated' | 'all'>('outdated')
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const newer = useQuery({ queryKey: ['analysis', 'preview', 'outdated'], queryFn: ({ signal }) => apiGet('/api/analysis/runs/preview', { params: { query: { mode: 'outdated' } }, signal }) })
  const whole = useQuery({ queryKey: ['analysis', 'preview', 'all'], queryFn: ({ signal }) => apiGet('/api/analysis/runs/preview', { params: { query: { mode: 'all' } }, signal }) })
  const preview = mode === 'outdated' ? newer : whole
  const setting = (key: string) => config.data?.groups.flatMap(g => g.settings).find(row => row.key === key)
  const auto = setting('KROBI_ANALYSIS_AUTO')
  const run = summary.data?.run
  const active = run && run.done + run.failed < run.size
  const helper = computers.find(c => !c.nest && c.jobs.includes('analysis'))
  const waitingWord = helper ? t("Waiting for {{name}}", { name: helper.name }) : t("Waiting for a helper_computer")
  async function refresh() {
    await Promise.all([queryClient.invalidateQueries({ queryKey: analysisKeys.summary }), queryClient.invalidateQueries({ queryKey: ['analysis', 'preview'] }), queryClient.invalidateQueries({ queryKey: computeKey })])
  }
  async function start() {
    setBusy(true)
    setWaiting(false)
    try { await apiPost('/api/analysis/runs', { body: { requestId: crypto.randomUUID(), mode, scope: 'library' } }); await refresh() }
    catch (error) {
      const body = isApiError(error) ? error.body : null
      if (body && typeof body === 'object' && 'detail' in body && body.detail && typeof body.detail === 'object' && 'code' in body.detail && body.detail.code === 'no-helper') setWaiting(true)
      else toast(t("Couldn't start analysis"), { err: true })
    } finally { setBusy(false) }
  }
  async function stop() {
    if (!run) return
    setBusy(true)
    try { await apiPost('/api/jobs/{job_id}/cancel', { params: { path: { job_id: run.jobId } } }); await refresh() }
    catch { toast(t("Couldn't stop analysis"), { err: true }) }
    finally { setBusy(false) }
  }
  async function writeTags(value: boolean, undo = true) {
    setBusy(true)
    try {
      await apiPut('/api/config/analysis-tags', { body: { write_analysis_tags: value } })
      await queryClient.invalidateQueries({ queryKey: queryKeys.server.analysisTags() })
      toast(t(value ? "Analysis is saved in the files" : "Analysis is no longer saved in the files"), undo ? { undo: () => void writeTags(!value, false) } : {})
    }
    catch { toast(t("Could not save the change"), { err: true }) }
    finally { setBusy(false) }
  }
  return <div className="bw-analysis">
    <section className="settings-block ks-group"><div className="settings-block__head"><h3>{t("Library")}</h3></div>
    {summary.isError ? <QueryFailure error={summary.error} what={t("the analysis")} onRetry={() => void summary.refetch()} /> : !summary.data ? <Skel rows={2} /> : <div className="ks-row"><span className="ks-l"><b>{t("Analyzed")}</b><span>{summary.data.analyzed} / {summary.data.total}</span></span><div className="z-meter"><i style={{ width: `${summary.data.total ? summary.data.analyzed / summary.data.total * 100 : 0}%` }} /></div></div>}
    {active ? <div className="ks-row" role="status"><span className="ks-l"><b>{t("Running_execution")}</b><span>{t("{{n}} of {{total}}", { n: run.done, total: run.size })}{run.etaSeconds != null ? ` · ${t("about {{n}} min", { n: Math.ceil(run.etaSeconds / 60) })}` : ''}</span>{run.waiting ? <Word tone="warn">{waitingWord}</Word> : null}</span><button className="ks-btn" type="button" disabled={busy} onClick={() => void stop()}>{t("Stop")}</button></div> : null}
    <div className="ks-row"><b>{t("Analyze new songs automatically")}</b><Switch label={t("Analyze new songs automatically")} checked={auto?.value === true} disabled={!auto?.editable || auto.source === 'env' || saving} onChange={value => void save({ KROBI_ANALYSIS_AUTO: value })} /></div>
    <h4>{t("Re-analyze")}</h4>
    <div className="bw-analysis-scope" role="group" aria-label={t("Re-analyze")}>{(['outdated', 'all'] as const).map(value => {
      const item = value === 'outdated' ? newer : whole
      return <label title={value === 'all' ? [t("Waits for a helper; never runs on the nest CPU"), item.data ? t("Keeps {{corrections}} corrections and {{confirmations}} confirmations", { corrections: item.data.correctionsKept, confirmations: item.data.confirmationsKept }) : null].filter(Boolean).join(' · ') : undefined} className={`bw-choice${mode === value ? ' is-selected' : ''}`} key={value}><input type="radio" name="analysis-scope" checked={mode === value} onChange={() => { setMode(value); setWaiting(false) }} /><span><b>{t(value === 'outdated' ? "New or outdated" : "Whole library")} · {item.data?.size ?? <Missing kind="loading" />}</b>{item.data?.estimateSeconds != null ? <small>{t("about {{n}} min", { n: Math.max(1, Math.ceil(item.data.estimateSeconds / 60)) })}</small> : null}</span></label>
    })}</div>
    {preview.isError ? <QueryFailure error={preview.error} what={t("the analysis")} onRetry={() => void preview.refetch()} /> : null}
    {waiting ? <div role="status"><Word tone="warn">{waitingWord}</Word></div> : null}

    {summary.data?.failed ? <Word tone="bad">{t("Couldn't analyze {{n}} songs", { n: summary.data.failed })}</Word> : null}
    <div className="bw-footer"><OutdatedStatus count={summary.data?.outdated ?? 0} /><button className="ks-btn ks-btn--go" type="button" disabled={busy || !!active || !preview.data?.size} onClick={() => void start()}>{t("Analyze {{n}} songs", { n: preview.data?.size ?? 0 })}</button></div>
    <RunsOn kind="analysis" />
    </section>
    <section className="settings-block ks-group"><div className="settings-block__head"><h3>{t("Results")}</h3></div>
    <div className="ks-row"><b>{t("Save BPM and key in the files")}</b><Switch label={t("Save BPM and key in the files")} checked={tags.data === true} disabled={busy || !tags.isSuccess} onChange={value => void writeTags(value)} /></div>
    <div className="ks-row"><span className="ks-l"><b>{t("Estimates")}</b>{summary.data ? <span>{t("{{n}} songs · {{keys}} keys · {{bpms}} BPM", { n: summary.data.estimated.songs, keys: summary.data.estimated.keys, bpms: summary.data.estimated.bpms })}</span> : null}</span><button className="ks-link" type="button" onClick={() => go('estimates')}>{t("Review_estimates")}</button></div>
    <div className="ks-row"><span className="ks-l"><b>{t("Accuracy")}</b><span>{t("Key {{key}} % exact · BPM {{bpm}} % ±4 %", { key: Math.round(accuracyData.giantsteps.key.all.exact.pct), bpm: Math.round(accuracyData.giantsteps.tempo.v2.all.accuracy1.pct) })}</span></span><button className="ks-link" type="button" onClick={() => go('accuracy')}>{t("Details")}</button></div>
    </section>
  </div>
}
