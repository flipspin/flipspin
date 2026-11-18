/** Register imports with the downloads store and release the form immediately.
 * The job must survive navigation away from Settings. */
import { useId, useState } from 'react'
import { Button } from '../ui/react/components/Button'
import { Input } from '../ui/react/components/Input'
import { ImportSourceTabs, type ImportSource } from './ImportSourceTabs'
import './import-panel.css'

import { isApiError, serverDetail, spotifyConfigured, useSpotifyStatus } from '../data'
import { openSettings } from '../shell/ServerBadge'
import { requestLanding } from '../settings/landing'
import { Word } from '../settings/parts'
// The shipping app's store, not a second one. A download started here has
// to appear in the same "Descargas activas" panel as every other download.
import { track as trackDownload } from '../downloads/downloadsStore'
import {
  downloadFromYoutube,
  importPlaylist,
  previewPlaylist,
  type PlaylistPreview,
} from './gateway'
import { IMPORT_COPY as COPY } from './messages'
import i18n from '../i18n'
import { useTranslation } from 'react-i18next'


/** What the panel is saying under the form. One at a time, on purpose. */
type Report =
  | { kind: 'none' }
  | { kind: 'started'; label: string }
  | { kind: 'landed'; files: string[] }
  | { kind: 'failed'; message: string }

/** Keep the server's actionable failure reason, including missing Spotify credentials. */
function reasonFor(error: unknown): string {
  if (isApiError(error)) return serverDetail(error) ?? error.userMessage
  return i18n.t(COPY.genericFailure)
}

export interface ImportPanelProps {
  /** Let the host navigate to downloads so embedded Settings does not create another routing path. */
  onShowDownloads?: () => void
}

export function ImportPanel({ onShowDownloads }: ImportPanelProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const [source, setSource] = useState<ImportSource>('playlist')
  const panelId = useId()
  const [report, setReport] = useState<Report>({ kind: 'none' })

  return (
    <section aria-labelledby="settings-import" className="mk-card mk-card--green import-panel">
      <div className="mk-stack--tight">
        <h3 id="settings-import" className="mk-card__title">{t("From a link or a search")}</h3>
        <p className="z-say">
          {t(COPY.blurb)}
        </p>
      </div>

      <ImportSourceTabs source={source} panelId={panelId} onChange={(value) => {
        setSource(value)
        setReport({ kind: 'none' })
      }} />

      <div id={panelId} role="tabpanel" aria-label={t(source === 'playlist' ? 'Playlist' : 'YouTube')}>
        {source === 'playlist' ? <PlaylistImport onReport={setReport} /> : null}
        {source === 'youtube' ? <YoutubeImport onReport={setReport} /> : null}
      </div>

      <ReportLine report={report} onShowDownloads={onShowDownloads} />
    </section>
  )
}

interface ModeProps {
  onReport: (report: Report) => void
}

/** Disable import while checking Spotify configuration. If that check fails,
 * allow submission so the server can return its own actionable error. */
function PlaylistImport({ onReport }: ModeProps): React.JSX.Element {
  const { t } = useTranslation()
  const status = useSpotifyStatus()
  const configured = status.isSuccess ? spotifyConfigured(status.data) : null
  if (configured === false) {
    return (
      <div className="import-panel__missing" title={t("The nest doesn't have the Spotify app's credentials")}>
        <Word tone="warn">{t("Spotify not set up")}</Word>
        <Button type="button" variant="primary" onClick={() => { requestLanding('spotify-keys'); openSettings('fuentes') }}>
          {t("Set up Spotify")}
        </Button>
      </div>
    )
  }
  return <PlaylistForm onReport={onReport} waiting={status.isPending} />
}

function PlaylistForm({ onReport, waiting }: ModeProps & { waiting: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')
  const [preview, setPreview] = useState<PlaylistPreview | null>(null)
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null)

  const trimmed = url.trim()

  return (
    <form
      style={{ display: 'grid', gap: 'var(--space-3)' }}
      onSubmit={(event) => {
        event.preventDefault()
        if (trimmed === '' || busy !== null || waiting) return
        setBusy('import')
        onReport({ kind: 'none' })
        importPlaylist(trimmed, preview?.trackCount ?? 0)
          .then((job) => {
            trackDownload({
              id: job.progressId,
              label: preview?.name ?? t(COPY.untitledPlaylist),
              total: job.total,
            })
            onReport({ kind: 'started', label: preview?.name ?? t(COPY.untitledPlaylist) })
            setUrl('')
            setPreview(null)
          })
          .catch((error: unknown) => onReport({ kind: 'failed', message: reasonFor(error) }))
          .finally(() => setBusy(null))
      }}
    >
      <label style={{ display: 'grid', gap: 'var(--space-1)' }}>
        <span className="z-label">{t(COPY.playlistLabel)}</span>
        <Input

          type="url"
          value={url}
          disabled={waiting}
          placeholder="https://open.spotify.com/playlist/…"
          onChange={(event) => {
            setUrl(event.target.value)
            // The preview describes the previous link. Keeping it while the
            // field says something else is how you import the wrong playlist.
            setPreview(null)
          }}
        />
      </label>

      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap' }}>
        <Button
          type="button"
          variant="secondary"
          disabled={trimmed === '' || busy !== null || waiting}
          onClick={() => {
            setBusy('preview')
            onReport({ kind: 'none' })
            previewPlaylist(trimmed)
              .then(setPreview)
              .catch((error: unknown) => onReport({ kind: 'failed', message: reasonFor(error) }))
              .finally(() => setBusy(null))
          }}
        >
          {busy === 'preview' ? t("Looking…") : t("See what's in it")}
        </Button>

        <Button type="submit" variant="primary" disabled={trimmed === '' || busy !== null || waiting}>
          {busy === 'import'
            ? t("Starting…")
            : preview
              ? t("Import {{count}} songs", { count: preview.trackCount })
              : t("Import_verb")}
        </Button>
      </div>

      {preview ? (
        <div className="mk-inset mk-inset--app" style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
          {preview.coverUrl ? (
            <img
              src={preview.coverUrl}
              alt=""
              width={44}
              height={44}
              style={{ borderRadius: 'var(--radius-sm)', border: 'var(--border-w) solid var(--color-border-bold)' }}
            />
          ) : null}
          <div>
            <strong>{preview.name}</strong>
            <div className="mk-meta">
              {t("{{n}} songs", { count: preview.trackCount, n: preview.trackCount })}
            </div>
          </div>
        </div>
      ) : null}
    </form>
  )
}

/** A link to a video. The escape hatch for anything the catalogs cannot find. */
function YoutubeImport({ onReport }: ModeProps): React.JSX.Element {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <form
      style={{ display: 'grid', gap: 'var(--space-3)' }}
      onSubmit={(event) => {
        event.preventDefault()
        const trimmed = url.trim()
        if (trimmed === '' || busy) return
        setBusy(true)
        onReport({ kind: 'none' })
        downloadFromYoutube(trimmed, name.trim() || null)
          .then((files) => {
            onReport({ kind: 'landed', files })
            setUrl('')
            setName('')
          })
          .catch((error: unknown) => onReport({ kind: 'failed', message: reasonFor(error) }))
          .finally(() => setBusy(false))
      }}
    >
      <label style={{ display: 'grid', gap: 'var(--space-1)' }}>
        <span className="z-label">{t(COPY.youtubeLabel)}</span>
        <Input

          type="url"
          value={url}
          placeholder="https://www.youtube.com/watch?v=…"
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>

      <label style={{ display: 'grid', gap: 'var(--space-1)' }}>
        <span className="z-label">{t(COPY.youtubeNameLabel)}</span>
        <Input

          type="text"
          value={name}
          placeholder={t("Optional")}
          onChange={(event) => setName(event.target.value)}
        />
      </label>

      <div>
        <Button type="submit" variant="primary" disabled={url.trim() === '' || busy}>
          {busy ? t("Downloading…") : t("Download_verb")}
        </Button>
      </div>

      {/* Explain the wait because this route returns only after the file lands. */}
      <p className="z-say">{t(COPY.youtubeWait)}</p>
    </form>
  )
}

function ReportLine({
  report,
  onShowDownloads,
}: {
  report: Report
  onShowDownloads?: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (report.kind === 'none') return null

  if (report.kind === 'failed') {
    return (
      <p className="mk-empty mk-empty--alarm" role="alert" style={{ margin: 0 }}>
        {report.message}
      </p>
    )
  }

  if (report.kind === 'landed') {
    return (
      <div className="mk-empty" role="status">
        <p className="mk-empty__title">{t(COPY.landed)}</p>
        {report.files.length > 0 ? (
          <p className="mk-meta">{report.files.join(', ')}</p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="mk-empty" role="status">
      <p className="mk-body">
        <strong>{report.label}</strong> {t(COPY.started)}
      </p>
      {/* The job is elsewhere now, so the panel says where. */}
      {onShowDownloads ? (
        <Button type="button" variant="secondary" onClick={onShowDownloads}>
          {t("View downloads")}
        </Button>
      ) : (
        <p className="z-say">{t("You can follow it under “Active downloads”.")}</p>
      )}
    </div>
  )
}
