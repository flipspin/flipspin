import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { msg } from '../../i18n'
import { Missing } from '../../ui/react/components/Missing'
import { useOffline } from '../../offline/useOffline'
import { useSettings } from '../context'
import { fixNowCount, healthSourceTitle, isFixNow, useLibraryHealth, type HealthCheck, type LibraryHealthData } from '../healthData'
import { Dot, QueryFailure, Skel } from '../parts'
import { Page } from './Head'
import './library-health.css'

const LABELS: Record<HealthCheck['id'], string> = {
  missing: msg("Missing files_translated"), unreadable: msg("Unreadable files"),
  estimates: msg("Estimates to confirm"), duplicates: msg("Possible duplicates"),
  unmatched: msg("Albums not matched on MusicBrainz"), remaster: msg("Remaster suffix in titles"),
}

function elapsed(value: string | number | null, t: TFunction): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return t("Never")
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000))
  return minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.floor(minutes / 60)} h` : t("{{count}} days", { count: Math.floor(minutes / 1440) })
}

function Facts({ check }: { check: HealthCheck }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (check.state === 'unavailable') return null
  switch (check.id) {
    case 'missing': return <><span>{t("{{songs}} in {{folders}}", { songs: t("{{count}} songs", { count: check.count ?? 0 }), folders: t("{{count}} folders", { count: check.folders ?? 0 }) })}</span>{check.topFolder ? <code>{check.topFolder}</code> : null}</>
    case 'estimates': return <span>{t("{{keys}} keys · {{bpms}} BPM", { keys: check.keys, bpms: check.bpms })}</span>
    case 'duplicates': return <span>{t("{{groups}} groups · {{audio}} same audio · {{tags}} same tags", { groups: check.count, audio: check.sameAudio, tags: check.sameTags })}</span>
    case 'unmatched': return <span>{t("{{count}} songs without a MusicBrainz ID", { count: check.songs ?? 0 })}</span>
    case 'remaster': return <span>{t("“(Remastered 2009)” and similar")}</span>
    default: return null
  }
}

function CheckRow({ check, review }: { check: HealthCheck; review: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { host } = useSettings()
  const canReview = check.state === 'ready' && (check.count ?? 0) > 0
    && (check.id !== 'unmatched' || !!host.openHealthMatch)
  return <button type="button" className="lh-row" data-fix={isFixNow(check)} disabled={!canReview} onClick={review}
    title={`${healthSourceTitle(check.source)}${check.reason ? ` · ${check.reason}` : ''}`}>
    <span className="lh-count z-mono">{check.state === 'unavailable' ? <Missing kind="unavailable" /> : check.count?.toLocaleString()}</span>
    <span className="lh-row__text"><b>{t(LABELS[check.id])}</b><Facts check={check} /></span>
    {canReview ? <span className="lh-review ks-btn" aria-hidden>{check.id === 'unmatched' ? t("Match") : t("Review_match", {  })}</span> : null}
  </button>
}

function Stat({ stat, label, children, className = '' }: { stat: LibraryHealthData['stats']['songs']; label: React.ReactNode; children: React.ReactNode; className?: string }): React.JSX.Element {
  return <div className={`lh-stat ${className}`} title={`${healthSourceTitle(stat.source)}${stat.reason ? ` · ${stat.reason}` : ''}`}>
    <b className="z-mono">{stat.state === 'unavailable' ? <Missing kind="unavailable" /> : children}</b><span>{label}</span>
  </div>
}

function Stats({ data }: { data: LibraryHealthData }): React.JSX.Element {
  const { t } = useTranslation()
  const stats = data.stats
  const age = stats.lastBackupAt.value ? (Date.now() - Date.parse(String(stats.lastBackupAt.value))) / 86400_000 : Infinity
  const tone = age < 2 ? 'ok' : age < 7 ? 'warn' : 'bad'
  return <div className="lh-stats">
    <Stat stat={stats.songs} label={<>{t("songs")} · <span title={healthSourceTitle(stats.albums.source)}>{stats.albums.state === 'unavailable' ? <Missing kind="unavailable" /> : t("{{count}} albums", { count: Number(stats.albums.value) })}</span></>}>{stats.songs.value?.toLocaleString()}</Stat>
    <Stat stat={stats.addedThisWeek} className="lh-wide-stat" label={t("added this week")}>+{stats.addedThisWeek.value?.toLocaleString()}</Stat>
    <Stat stat={stats.lastScanAt} className="lh-wide-stat" label={t("since the last scan")}>{elapsed(stats.lastScanAt.value, t)}</Stat>
    <Stat stat={stats.lastBackupAt} label={<><Dot tone={tone} />{t("since the last backup")}</>}>{elapsed(stats.lastBackupAt.value, t)}</Stat>
  </div>
}

export function LibraryHealth(): React.JSX.Element {
  const { t } = useTranslation()
  const { admin, go, host } = useSettings()
  const offline = useOffline()
  const query = useLibraryHealth(admin === true)
  const [review, setReview] = useState<HealthCheck['id'] | null>(null)
  if (admin === false) return <Page id="health"><Missing kind="noAccess" /></Page>
  if (offline) return <Page id="health"><div className="settings-alt">{t("Nest offline")}</div></Page>
  if (query.isPending) return <Page id="health"><Skel rows={6} label={t("Loading library health")} /></Page>
  if (query.isError) return <Page id="health"><QueryFailure error={query.error} what={t("library health")} onRetry={() => void query.refetch()} /></Page>
  const data = query.data
  const fixes = data.checks.filter(isFixNow).filter(c => c.state === 'unavailable' || (c.count ?? 0) > 0)
  const suggestions = data.checks.filter(c => !isFixNow(c)).filter(c => c.state === 'unavailable' || (c.count ?? 0) > 0)
  const fixChecks = fixes.filter(c => c.state === 'ready').length
  const suggestionChecks = suggestions.filter(c => c.state === 'ready').length
  const unknown = fixes.some(c => c.state === 'unavailable')
  const note = `${fixChecks ? t("{{count}} to fix", { count: fixChecks }) : unknown ? t("Not checked_unreviewed") : t("All clear").toLocaleLowerCase()} · ${t("{{count}} suggestions", { count: suggestionChecks })}`
  const reviewCheck = (check: HealthCheck) => {
    if (check.id === 'missing') go('missing')
    else if (check.id === 'duplicates') go('duplicates')
    else if (check.id === 'estimates') go('estimates')
    else if (check.id === 'unmatched' && check.albumKeys?.length === 1) host.openHealthMatch?.({ albumKey: check.albumKeys[0] })
    else setReview(check.id)
  }
  const back = <div className="cx-crumb"><button className="ks-link" type="button" onClick={() => setReview(null)}>{t("Library health")}</button><span>›</span></div>
  if (review === 'remaster') {
    const check = data.checks.find(c => c.id === 'remaster')
    const tracks = check?.tracks ?? []
    return <Page id="health" before={back} sub={t("Remaster suffix in titles")}>
      <div className="lh-panel"><div className="lh-panel__head"><span title={check ? healthSourceTitle(check.source) : undefined}>{t("{{count}} songs", { count: tracks.length })}</span>
        <button type="button" className="ks-btn" disabled={!host.openHealthBulkTags || !tracks.length || tracks.length > 500} title={tracks.length > 500 ? t("Select up to 500 songs") : undefined} onClick={() => host.openHealthBulkTags?.(tracks.map(row => row.relPath))}>{t("Edit all")}</button></div>
        {tracks.map(row => <button className="lh-row" key={row.relPath} type="button" disabled={!host.openEstimateInfo} onClick={() => host.openEstimateInfo?.(row.relPath)}><span className="lh-row__text"><b>{row.title}</b><span>{row.artist}</span><code>{row.relPath}</code></span></button>)}
      </div>
    </Page>
  }
  if (review === 'unmatched') {
    const albums = data.checks.find(c => c.id === 'unmatched')?.albumKeys ?? []
    return <Page id="health" before={back} sub={t("Albums not matched on MusicBrainz")}><div className="lh-panel">{albums.map(album => <button className="lh-row" type="button" key={album} onClick={() => host.openHealthMatch?.({ albumKey: album })}><span className="lh-row__text"><b>{album}</b></span><span className="lh-review ks-btn" aria-hidden>{t("Match")}</span></button>)}</div></Page>
  }
  return <Page id="health" sub={<span className="z-mono" title={data.checks.map(c => healthSourceTitle(c.source)).join('\n')}>{note}</span>}>
    <div className="lh-page">
      <Stats data={data} />
      {fixes.length ? <section className="lh-panel" aria-label={t("Fix now")}>
        <div className="lh-panel__head"><span><Dot tone="bad" />{t("Fix now")}</span><small className="z-mono" title={fixes.map(c => healthSourceTitle(c.source)).join('\n')}>{unknown ? <Missing kind="unavailable" /> : fixNowCount(data)}</small></div>
        {fixes.map(check => <CheckRow key={check.id} check={check} review={() => reviewCheck(check)} />)}
      </section> : <section className="lh-panel lh-clear" aria-label={t("All clear")}><b><Dot tone="ok" />{t("All clear")}</b><span className="z-mono" title={data.checks.filter(isFixNow).map(c => healthSourceTitle(c.source)).join('\n')}>{t("checked {{time}} ago", { time: elapsed(data.checkedAt, t) })}</span></section>}
      <section className="lh-panel" aria-label={t("Suggestions")}>
        <div className="lh-panel__head"><span><Dot />{t("Suggestions")}</span><small className="z-mono" title={suggestions.map(c => healthSourceTitle(c.source)).join('\n')}>{t("{{count}} checks", { count: suggestions.length })}</small></div>
        {suggestions.map(check => <CheckRow key={check.id} check={check} review={() => reviewCheck(check)} />)}
      </section>
    </div>
  </Page>
}
