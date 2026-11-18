import { Search, X } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { msg } from '../i18n'
import { changeOfflineTrack, offlineReason, useOfflineStorage } from '../offline/useOfflineStorage'
import JobRowLayout, { actionClass } from './JobRowLayout'
import { pausedAcquisitionItem, type GroupedWorkRow } from './jobRowPresentation'
import { acquisitionLive, clearAcquisition, retryAcquisition, type AcquisitionJob, type AcquisitionReason, type AcquisitionStage } from './acquisitionJobs'
import { RetrySheet, type RetryFailure } from './DownloadRetryModal'

const REASONS: Record<AcquisitionReason, string> = {
  'no-encontrada': msg("Not found"), 'fallo-descarga': msg("Download failed"),
  'fallo-importar': msg("Could not import"), 'sin-espacio': msg("Nest out of space"), 'en-pausa': msg("Paused"),
}
const STAGES: Record<AcquisitionStage, string> = {
  request: msg("Searching"), match: msg("Searching"), fetch: msg("Downloading to the nest"),
  import: msg("Importing"), link: msg("Importing"),
}
export function AcquisitionRow({ job }: { job: AcquisitionJob }) {
  const { t, i18n } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [manual, setManual] = useState<RetryFailure | null>(null)
  const detailsId = useId()
  const paused = pausedAcquisitionItem(job)
  const live = acquisitionLive(job)
  const restoring = job.provider === 'library-readd'
  const active = paused ?? job.items.find(item => item.state === 'running') ?? job.items.find(item => item.state === 'queued')
  const failures = job.items.filter((item, index, items) => item.state === 'failed' && !items.slice(0, index).some(prior => prior.state === 'failed' && (prior.detail.index ?? prior.idx) === (item.detail.index ?? item.idx) && prior.reason === item.reason))
  const stage = active?.stage ?? (job.state === 'importing' || job.stages.import || job.stages.link ? 'import' : job.state === 'fetching' || job.stages.fetch ? 'fetch' : 'match')
  const failed = job.state === 'parcial' || job.state === 'fallido'
  const until = typeof paused?.detail.until === 'number' ? new Date(paused.detail.until * 1000).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit' }) : null
  const source = typeof paused?.detail.provider === 'string' ? paused.detail.provider : 'youtube'
  const sourceName = source === 'youtube' ? 'YouTube' : source
  const word = paused ? until ? t("Paused until {{time}}", { time: until }) : t("Paused")
    : live ? t(STAGES[stage])
    : failed ? t("{{failed}} of {{total}} failed", { count: failures.length, failed: failures.length, total: job.expected_tracks })
    : job.state === 'completo' ? restoring ? t("Back in the nest") : t("Done") : t("Cancelled")
  const fact = live ? [active?.detail.title ?? active?.item, `${job.imported_tracks} / ${job.expected_tracks}`].filter(Boolean).join(' · ')
    : job.state === 'completo' ? t("{{n}} songs", { count: job.imported_tracks, n: job.imported_tracks }) : ''
  const percent = live && !paused ? Math.max(0, Math.min(100, Math.round(job.expected_tracks > 0 ? job.imported_tracks / job.expected_tracks * 100 : 0))) : undefined
  const clear = async () => {
    setBusy(true); setError(false)
    try { await clearAcquisition(job.id) } catch { setError(true) } finally { setBusy(false) }
  }
  const retry = async () => {
    setBusy(true); setError(false)
    try { await retryAcquisition(job.id) } catch { setError(true) } finally { setBusy(false) }
  }
  return <JobRowLayout label={job.title} title={restoring && live ? t("Re-adding · {{title}}", { title: job.title }) : job.title} kind={restoring ? t("Re-adding_action") : t("Download")} mark="DL" color="var(--green)"
    word={word} tone={paused ? 'var(--yellow)' : failed ? 'var(--rose)' : live ? 'var(--teal)' : 'var(--green)'} fact={fact}
    tooltip={paused ? until ? t("Waiting for {{name}} · until {{time}}", { name: sourceName, time: until }) : t("Waiting for {{name}}", { name: sourceName }) : undefined} percent={percent}
    actions={<>
      {!live ? <button type="button" className={actionClass} disabled={busy} aria-label={t("Remove from list")} title={t("Remove from list")} onClick={() => void clear()}><X aria-hidden="true" size={14} /></button> : null}
      {failed ? <button type="button" className={actionClass} disabled={busy} aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>{t("View {{n}}", { n: failures.length })}</button> : null}</>}>
    {error ? <p role="alert" className="mt-2 text-[12px] text-[var(--rose)]">{t("Could not complete the action. Try again.")}</p> : null}
    {expanded && failed ? <div id={detailsId} className="ml-10 mt-2 border-t border-[var(--line-soft)] pt-1">
      <ul aria-label={t("Songs that failed")} className="mt-2 flex flex-col gap-1.5">
        {failures.map(item => <li className="flex items-center gap-2 text-[12px]" key={`${item.stage}:${item.idx}`}>
          <span className="flex-1 min-w-0 truncate" title={item.item}>{item.detail.title ?? item.item}</span>
          <span className="shrink-0 inline-flex items-center gap-1.5 text-[var(--rose)]"><span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-[var(--rose)]" />{t(REASONS[item.reason as AcquisitionReason] ?? msg("Failed"))}</span>
          {['no-encontrada', 'fallo-descarga'].includes(item.reason) && <button type="button" className={actionClass} disabled={busy} onClick={() => {
            const index = item.detail.index ?? item.idx
            const track = job.tracks?.[index]
            const title = track?.title ?? item.detail.title ?? item.item
            const query = [title, track?.artist].filter(Boolean).join(' ')
            setManual({ index, item: item.item, title, artist: track?.artist ?? null, durationS: track?.duration_s ?? null,
              query, kind: item.reason === 'no-encontrada' ? 'rejected' : 'download', reason: item.reason,
              suggestions: [...new Set([query, `${query} audio`, title])] })
          }}><Search size={11} aria-hidden="true" />{t("Search another way")}</button>}
        </li>)}
      </ul>
      <button type="button" className={`${actionClass} mt-2`} disabled={busy || live} onClick={() => void retry()}>{t("Retry")}</button>
    </div> : null}
    {manual && <RetrySheet key={manual.index} open failure={manual} onClose={() => setManual(null)} onPick={async url => {
      await retryAcquisition(job.id, { index: manual.index, youtube_url: url })
    }} />}
  </JobRowLayout>
}

/** Keep one retry state while the caller places local rows alongside the ledger groups. */
export function LocalDownloadRows({ storage, children }: {
  storage: ReturnType<typeof useOfflineStorage>
  children: (rows: GroupedWorkRow[]) => ReactNode
}) {
  const { t } = useTranslation()
  const { data, error, refresh } = storage
  const [busy, setBusy] = useState<string | null>(null)
  const [failedAction, setFailedAction] = useState(false)
  const tracks = data?.status.tracks.filter(track => track.pool === 'offline') ?? []
  const retry = async (key: string) => {
    if (!data) return
    setBusy(key); setFailedAction(false)
    try { await changeOfflineTrack(data.pools, key, false); await refresh() } catch { setFailedAction(true) } finally { setBusy(null) }
  }
  const rows: GroupedWorkRow[] = tracks.map(track => {
    const failed = track.state === 'fallido' || track.state === 'ya no está en el nido'
    const group = track.state === 'en fila' ? 'waiting' : track.state === 'descargando' ? 'running' : 'terminal'
    return { key: `local:${track.key}`, group, row: <JobRowLayout label={track.key} title={track.key.split('/').pop()} kind={t("This computer")} mark="EQ" color="var(--blue)" whiteMark
      word={failed ? t(offlineReason(track)) : track.state === 'descargado' ? t("Downloaded") : track.state === 'en fila' ? t("Queued_line") : t("Downloading to this computer")}
      tone={failed ? 'var(--rose)' : group === 'waiting' ? 'var(--ink-3)' : group === 'running' ? 'var(--teal)' : 'var(--green)'}
      actions={failed ? <button type="button" className={actionClass} disabled={!!busy || !data?.pools.pins} onClick={() => void retry(track.key)}>{t("Retry")}</button> : null} /> }
  })
  return <>
    {children(rows)}
    {failedAction ? <div role="alert" className="px-3 py-2 text-[12px] text-[var(--rose)]">{t("Could not complete the action. Try again.")}</div> : null}
    {error && data ? <div className="px-3 py-2 text-[12px] text-[var(--rose)]">{t("Could not read storage")}</div> : null}
  </>
}

/** Upload and offline jobs can supply rows here without another popover or banner. */
export interface WorkExtensions { uploadBatches?: ReactNode; pendingChanges?: ReactNode }
