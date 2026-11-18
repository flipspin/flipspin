/** Lyrics add-on installation and synchronization. */
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { watchJobs } from '../../lyrics/lyricsStore'
import { apiGet } from '../../data'
import { QueryFailure, Skel, Word } from '../parts'
import { helperPhase } from '../helper'
import { formatCount } from '../format'
import { useSettings } from '../context'
import { Missing } from '../../ui/react/components/Missing'
import { useCompute } from '../background/data'
import { Page } from './Head'
import { Coverage, CatalogJob } from './NestLyrics'
import { RunsOn } from '../background/RunsOn'

function SyncJobs(): React.JSX.Element {
  const { t } = useTranslation()
  const { admin } = useSettings()
  const compute = useCompute(admin === true)
  const kind = compute.data?.kinds.find(kind => kind.kind === 'align')
  const query = useQuery({ queryKey: ['jobs', 'lyrics-sync'], queryFn: ({ signal }) => apiGet('/api/jobs', { signal }) })
  const jobs = query.data?.jobs.filter(job => job.kind === 'lyrics-helper') ?? []
  return <section className="settings-block ks-group" aria-label={t("Sync jobs")}>
    <div className="settings-block__head"><h3>{t("Sync jobs")}</h3><span className="settings-count">{kind ? t("{{n}} waiting", { n: kind.waiting }) : <Missing kind={compute.isError ? 'nodata' : 'loading'} />}</span><button className="ks-link settings-head-act" type="button" onClick={() => window.dispatchEvent(new CustomEvent('krobi:open-jobs'))}>{t("View in Jobs")}</button></div>
    {query.isError ? <QueryFailure error={query.error} what={t("sync jobs")} onRetry={() => void query.refetch()} /> : query.isPending ? <Skel rows={2} /> : <>
      {query.data?.degraded.includes('lyrics') ? <QueryFailure error={null} what={t("sync jobs")} onRetry={() => void query.refetch()} /> : null}
      {jobs.map(job => {
        const running = job.state === 'running'
        const failed = job.state === 'failed' || job.state === 'partial' || job.state === 'interrupted'
        const word = running ? job.phase ? helperPhase(job.phase, t) : t("syncing") : job.state === 'queued' || job.state === 'waiting' ? t("Queued") : job.state === 'cancelled' ? t("Cancelled") : failed ? t("Failed") : t("Done")
        return <div className="ks-row" key={job.id}>
          <div className="ks-l"><b>{job.label}</b><span>{job.item}</span><span>{formatCount(job.succeeded + job.failed + job.skipped)} / {formatCount(job.total)}</span></div>
          <div className="ks-c"><Word tone={failed ? 'bad' : running ? 'ok' : 'off'}>{word}{running && Number.isFinite(job.percent) ? ` · ${job.percent} %` : ''}</Word></div>
        </div>
      })}
      {!jobs.length && !query.data?.degraded.includes('lyrics') ? <div className="ks-row">{t("Nothing running")}</div> : null}
    </>}
    <RunsOn kind="align" />
  </section>
}

export function Lyrics(): React.JSX.Element {
  useEffect(() => watchJobs(), [])
  return <Page id="letras">
    <Coverage />
    <CatalogJob />
    <SyncJobs />
  </Page>
}
