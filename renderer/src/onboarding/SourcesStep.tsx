import { useState, type CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { apiGet, useCurrentUser } from '../data'
import { msg } from '../i18n'
import { Button } from '../ui/react/components/Button'
import { useKnownSources, useSourceInstall } from '../settings/sourceInstall'
import { WizardFrame } from './Shell'
import './steps.css'

const HUES = ['coral', 'teal', 'yellow', 'blue']
const SPECS = [
  { label: msg("Finds"), value: msg("official uploads first"), tip: msg("Searches YouTube Music and prefers the artist's official upload") },
  { label: msg("Format"), value: msg("AAC · m4a"), tip: msg("As YouTube serves it; nothing is re-encoded") },
  { label: msg("Downloader"), value: msg("yt-dlp"), tip: msg("yt-dlp, public domain (Unlicense)") },
  { label: msg("Runs"), value: msg("on the nest"), tip: msg("Songs land in the nest's library; this computer can be off") },
] as const

type Song = { title: string; artist: string }

/** The songs Home's Trending row will offer, so the step shows what an audio source unlocks. */
function useTrendingSongs(): Song[] {
  const dashboard = useQuery({ queryKey: ['setup-trending'], staleTime: Infinity, retry: false,
    queryFn: ({ signal }) => apiGet('/api/dashboard', { params: { query: {} }, signal }) })
  const rows = (dashboard.data as { rows?: { id?: string; items?: { title?: string; name?: string; subtitle?: string; artist?: string }[] }[] } | undefined)?.rows
  const items = rows?.find(row => row.id === 'top-tracks')?.items ?? []
  return items.map(item => ({ title: String(item.title ?? item.name ?? '').trim(), artist: String(item.subtitle ?? item.artist ?? '').trim() }))
    .filter(song => song.title).slice(0, 4)
}

function TrendingPreview(): React.JSX.Element {
  const { t } = useTranslation()
  const songs = useTrendingSongs()
  const rows: (Song | null)[] = songs.length ? songs : [null, null, null, null]
  return <div className="kob-trending">
    <div className="kob-trending__head"><span className="kob-dot is-ok" />{t("Trending songs")}</div>
    {rows.map((song, index) => <div key={song ? `${song.title}-${index}` : index} className={`kob-trending__row${song ? '' : ' is-ghost'}`}>
      <i style={{ '--_c': `var(--accent-${HUES[index % HUES.length]})` } as CSSProperties} />
      <span><b>{song?.title}</b><small>{song?.artist}</small></span>
      <em>+ {t("Add")}</em>
    </div>)}
  </div>
}

export interface SourcesStepProps {
  host: React.ReactNode
  initialPicked?: boolean
  onBack: () => void
  onDone: (picked: boolean) => void
}

/** Offers the audio source before the first add; the install keeps running on the nest while setup continues. */
export function SourcesStep({ host, initialPicked = true, onBack, onDone }: SourcesStepProps): React.JSX.Element {
  const { t } = useTranslation()
  const known = useKnownSources()
  const source = known.data?.sources[0]
  const install = useSourceInstall(source?.id ?? 'none')
  const installed = Boolean(source?.installed || install.succeeded)
  const me = useCurrentUser()
  const owner = me.data?.isOwner === true
  const [picked, setPicked] = useState(initialPicked)
  // Owner only (the install route is admin-only); an installed or in-flight source is never installed again.
  const canInstall = owner && Boolean(source) && !installed

  function next() {
    if (picked && canInstall && !install.busy && !install.job) void install.install({ id: source!.id })
    onDone(installed || (picked && canInstall))
  }

  return <WizardFrame step="sources" host={host} title={t("Get new music")} show={<TrendingPreview />}
    back={<Button className="kob-btn kob-btn--ghost" variant="ghost" onClick={onBack}>{t("Back")}</Button>}
    actions={<>
      <Button className="kob-btn" title={t("Also in Settings → Engines → Audio source")} onClick={() => onDone(installed)}>{t("Skip")}</Button>
      <Button className="kob-btn kob-btn--coral" variant="primary" onClick={next}>{t("Next")}</Button>
    </>}
  >
    <div className="kob-sources">
      <div className={`kob-option kob-addon kob-source${picked || installed ? ' is-picked' : ''}`}>
        <span className="kob-source__kicker" title={t("Where audio is downloaded from")}>{t("Audio source")}</span>
        <label className="kob-option-head">
          <span className="kob-dot kob-source-dot" aria-hidden="true" />
          <b>{source?.name ?? 'YouTube'}</b>
          <span className="kob-mono kob-muted" title={t("Published by flipspin")}>flipspin</span>
          {installed
            ? <small className="kob-source__state"><span className="kob-dot is-ok" aria-hidden="true" />{t("Installed")}</small>
            : <input type="checkbox" aria-label={t("Install {{name}}", { name: source?.name ?? 'YouTube' })} checked={picked && canInstall} disabled={!canInstall || install.busy} title={me.data && !owner ? t("Only an admin account can install sources") : undefined} onChange={event => setPicked(event.target.checked)} />}
        </label>
        <p>{t("Adds songs and albums you don't have yet.")}</p>
        <dl className="kob-specs">{SPECS.map(spec => <div className="kob-spec" key={spec.label}><dt>{t(spec.label)}</dt><dd className="kob-specs__v" title={t(spec.tip)}>{t(spec.value)}</dd></div>)}</dl>
        {known.isError ? <div className="kob-alert" role="alert">{t("Couldn't reach your nest. Check that it's still on.")}<Button className="kob-btn kob-btn--sm" size="sm" onClick={() => void known.refetch()}>{t("Retry")}</Button></div> : null}
      </div>
      <div className="kob-option kob-option--soon kob-addon" title={t("Lossless · comes after this release")}>
        <div className="kob-option-head"><span className="kob-dot is-off" aria-hidden="true" /><b>Soulseek</b><small>{t("Coming soon")}</small></div>
      </div>
    </div>
  </WizardFrame>
}
