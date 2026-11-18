import { AudioLines } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SchemaAnalysisSummary } from '../../api/generated/schema'
import { useAnalysisSummary } from '../../analysis/data'
import { accuracyData } from '../../analysis/calibration'
import { Missing } from '../../ui/react/components/Missing'
import { useSettings } from '../context'
import { useExtensions } from '../data'
import { formatCount } from '../format'
import { QueryFailure, Word, type Tone } from '../parts'
import { AddonCard, AddonRow, AddonSize } from './AddonCard'
import type { useAddonControls } from './useAddonControls'

export function AnalysisAddon({ management }: { management: ReturnType<typeof useAddonControls> }) {
  const { t } = useTranslation()
  const { admin, go } = useSettings()
  const extensions = useExtensions(admin === true)
  const summary = useAnalysisSummary(admin === true)
  const status = management.status
  const addon = status?.addons?.analysis
  const installing = status?.installing?.target === 'analysis' || addon?.installing === true
  const ready = addon?.ready === true
  const installed = addon?.installed === true
  // Analysis is a CPU add-on: shared torch memory/engine eligibility does not apply.
  const unavailable = admin !== true ? t("Admins only") : management.unavailable
  const data = summary.data
  let word = t("No computer")
  let reason = t("No computer has Analysis installed")
  let tone: Tone = 'off'
  if (data) {
    if (data.helper.working) { word = data.helper.name ? t("Analyzing · {{name}}", { name: data.helper.name }) : t("Analyzing"); reason = t("Key and BPM for each song"); tone = 'warn' }
    else if (data.analyzed === data.total) { word = t("Up to date_current"); reason = t("Each new song is analyzed on arrival"); tone = 'ok' }
    else if (installing || data.helper.online) { word = t("Waiting_pending"); reason = t("Waiting to analyze pending songs"); tone = 'warn' }
    else if (data.helper.name) { word = t("Waiting for a computer"); reason = t("{{name}} is offline", { name: data.helper.name }) }
  }
  const percent = data?.total ? Math.max(0, Math.min(100, data.analyzed / data.total * 100)) : 0
  return <AddonCard name={t("Analysis")} kind={t("Built-in")} icon={AudioLines} accent="amber" description={t("Key and BPM for each song")} onOpen={() => go('analisis')} disabled={admin !== true} disabledTitle={admin !== true ? t("Admins only") : undefined} engineState={installing ? 'installing' : ready ? 'ready' : 'uninstalled'}>
    {admin === true ? <>
      <AddonRow extension={extensions.data?.extensions.find(item => item.kind === 'engine' && item.id === 'analysis')} label={t("In the nest")} value={data ? coverage(data, t) : <Missing kind={summary.isError ? 'nodata' : 'loading'} />} statePrefix={<div className="z-meter cx-analysis-meter" role="progressbar" aria-label={t("Analyzed songs")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={data ? Math.round(percent) : undefined}><i style={{ width: `${percent}%` }} /></div>} state={data ? <Word tone={tone} title={reason}>{word}</Word> : null} />
      {summary.isError ? <QueryFailure error={summary.error} what={t("the analysis")} onRetry={() => void summary.refetch()} /> : null}
    </> : null}
    <AddonRow label={t("Accuracy")} mono title={t("Electronic dance · GiantSteps")}
      value={t("Key {{key}} % exact · BPM {{bpm}} % ±4 %", { key: Math.round(accuracyData.giantsteps.key.all.exact.pct), bpm: Math.round(accuracyData.giantsteps.tempo.v2.all.accuracy1.pct) })}
      state={null} actions={<button type="button" className="ks-link" onClick={() => go('accuracy')}>{t("Details_view")}</button>} />
    <AddonRow label={t("On this computer_device")} size={<AddonSize bytes={addon?.sizeBytes} installed={installed} estimate={100_000_000} details={t("TempoCNN, ONNX Runtime and KeyFinder · excludes dependencies shared with the engine · Does not need the engine")} />} value={t('KeyFinder · TempoCNN · CPU')} mono
      state={<Word tone={addon?.error ? 'bad' : installing ? 'warn' : ready ? 'ok' : 'off'} title={addon?.error || unavailable || undefined}>{unavailable ? t("Unavailable") : addon?.error ? t("Could not install Analysis") : installing ? t("Installing") : ready ? t("Installed") : t("Not installed")}</Word>}
      actions={<><label className="cx-use"><input type="checkbox" aria-label={t("Use {{addon}}", { addon: t("Analysis") })} checked={management.own?.limits.use?.analysis !== false} disabled={management.busy || !ready || !management.own || admin !== true} onChange={event => management.use('analysis', event.target.checked)} />{t("Use")}</label><button type="button" className="ks-btn" disabled={!!unavailable || !status || management.busy || !!status.installing || installing} title={unavailable || undefined} onClick={() => void management.act('analysis', installed)}>{installed ? t("Remove") : t("Install")}</button></>} />
    {installing ? <div className="cx-prog"><div className="z-meter" role="progressbar" aria-label={t("Installing Analysis")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={status?.installing?.percent ?? undefined}><i style={{ width: `${Math.max(0, Math.min(100, status?.installing?.percent ?? 0))}%` }} /></div><code>{t("Downloading models…")}{status?.installing?.percent != null ? ` · ${status.installing.percent} %` : ''}</code></div> : null}
  </AddonCard>
}
function coverage(data: SchemaAnalysisSummary, t: (key: string, options: Record<string, string>) => string) {
  return t("{{n}} of {{total}} analyzed", { n: formatCount(data.analyzed), total: formatCount(data.total) })
}
