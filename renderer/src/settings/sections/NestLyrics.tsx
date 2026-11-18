/** Nest-wide lyrics coverage and catalog search. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  setAutoFetch,
  startScan,
  useLyricsJobs,
  useLyricsJobsError,
  useLyricsJobsFailure,
  refreshJobs,
} from '../../lyrics/lyricsStore'
import { useLibrarySummary } from '../data'
import { formatCount } from '../format'
import { Count, QueryFailure, Skel, Switch, Word, useToast } from '../parts'

function unsearchedCount(total: number | null | undefined, covered: number | undefined, pending: number | undefined): number | null {
  if (![total, covered, pending].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return null
  return Math.max(0, total! - covered! - pending!)
}

export function Coverage(): React.JSX.Element {
  const { t } = useTranslation()
  const jobs = useLyricsJobs()
  const jobsError = useLyricsJobsError()
  const failure = useLyricsJobsFailure()
  const summary = useLibrarySummary()
  const total = summary.data?.songs ?? null
  const withLyrics = jobs?.withLyrics
  const pending = jobs?.pendingCount
  const unsearched = unsearchedCount(total, withLyrics, pending)
  const share = (n: number | undefined) => (Number.isFinite(n) && total && total > 0 ? `${Math.min(100, (n! / total) * 100)}%` : '0%')

  return (
    <div className="settings-block ks-group">
      <div className="settings-block__head">
        <h3>{t("Your library")}</h3>
        {jobs && total !== null ? (
          <span className="settings-count">
            <Count value={withLyrics} /> {t("of")} <Count value={total} /> {t("with lyrics")}
          </span>
        ) : null}
      </div>
      {jobsError ? (
        <QueryFailure error={failure} what={t("the library’s lyrics")} onRetry={() => void refreshJobs()} />
      ) : summary.isError ? (
        <QueryFailure error={summary.error} what={t("the library")} onRetry={() => void summary.refetch()} />
      ) : jobs === null || summary.isPending ? (
        <Skel rows={2} label={t("Loading the library’s lyrics")} />
      ) : (
        <div className="settings-block__body">
          <div className="settings-disk settings-disk--big" role="img" aria-label={t("{{n}} of {{total}} songs with lyrics", { n: formatCount(withLyrics), total: formatCount(total) })}>
            <i style={{ '--_c': 'var(--accent-teal)', width: share(withLyrics) } as React.CSSProperties} />
            <i style={{ '--_c': 'var(--accent-yellow)', width: share(pending) } as React.CSSProperties} />
          </div>
          <div className="settings-legend">
            <span style={{ '--_c': 'var(--accent-teal)' } as React.CSSProperties}>
              <span className="z-dot" />
              {t("With lyrics")} <Count value={withLyrics} />
            </span>
            <span style={{ '--_c': 'var(--accent-yellow)' } as React.CSSProperties}>
              <span className="z-dot" />
              {t("No lyrics in catalogs")}{' '}
              <Count value={pending} />
            </span>
            {<span style={{ '--_c': 'var(--color-bg-surface-dim)' } as React.CSSProperties}>
              <span className="z-dot" />
              {t("Not searched")} {unsearched !== null ? <Count value={unsearched} /> : null}
            </span>}
          </div>
        </div>
      )}

    </div>
  )
}

export function CatalogJob(): React.JSX.Element | null {
  const { t } = useTranslation()
  const toast = useToast()
  const jobs = useLyricsJobs()
  const jobsError = useLyricsJobsError()
  const summary = useLibrarySummary()
  const [busy, setBusy] = useState(false)
  if (!jobs || jobsError) return null

  const unsearched = unsearchedCount(summary.data?.songs, jobs.withLyrics, jobs.pendingCount)
  const flip = async (next: boolean, undo = true) => {
    setBusy(true)
    try {
      await setAutoFetch(next)
      toast(next ? t("Automatic search on") : t("Automatic search off"), undo ? { undo: () => void flip(!next, false) } : {})
    } catch {
      toast(t("Could not save the change"), { err: true })
    } finally {
      setBusy(false)
    }
  }
  const scan = async () => {
    setBusy(true)
    try {
      await startScan()
    } catch {
      toast(t("Could not start the search"), { err: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-block ks-group settings-catalog">
      <div className="settings-block__head">
        <h3>{t("Catalogs")}</h3><span>{t('LRCLIB · Genius')}</span>
        <div className="settings-job__counts">
          <span title={unsearched === null ? t("The nest did not send the data to calculate it.") : undefined}>{unsearched === null ? t("Not searched") : <><Count value={unsearched} /> {t("not searched")}</>}</span>
          {jobs.running ? (
            <Word tone="ok" title={[jobs.running.done, jobs.running.total].every(n => Number.isFinite(n) && n >= 0) ? undefined : t("The nest did not send the data to calculate it.")}>{t("searching · {{done}} of {{total}}", { done: formatCount(jobs.running.done), total: formatCount(jobs.running.total) })}</Word>
          ) : null}
        </div>
        <button className="ks-btn ks-btn--sm settings-head-act" type="button" disabled={busy || Boolean(jobs.running)} onClick={() => void scan()}>
          {t("Search now")}
        </button>
      </div>
      <div className="ks-row" data-config-key="KROBI_LYRICS_AUTO_FETCH">
        <div className="ks-l">
          <b title={jobs.running ? undefined : t("queued_line")}>{t("When songs are added")}</b>
          {jobs.lastRun ? (
            <span className="settings-job__when" title={[jobs.lastRun.found, jobs.lastRun.pending].every(n => Number.isFinite(n) && n >= 0) ? undefined : t("The nest did not send the data to calculate it.")}>{t("Last search: {{found}} found, {{pending}} without a result", { found: formatCount(jobs.lastRun.found), pending: formatCount(jobs.lastRun.pending) })}</span>
          ) : null}
        </div>
        <Switch label={t("When songs are added")} checked={jobs.autoFetch} disabled={busy} onChange={(next) => void flip(next)} />
      </div>
    </div>
  )
}
