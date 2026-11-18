import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder } from 'lucide-react'
import { apiPost } from '../data'
import { logger } from '../ui'
import { Button } from '../ui/react/components/Button'
import { useUploads } from '../uploads/uploadStore'
import { WizardFrame } from './Shell'
import { SpotifyMusicRow } from './SpotifyMusicRow'
import { MusicSources } from './MusicSources'
import { MusicUpload } from './MusicUpload'
import { LibraryAnalysis } from './LibraryAnalysis'
import { useMusicLibrary, type LibrarySummary } from './musicData'
import './steps.css'
import './music.css'

export type { LibrarySummary } from './musicData'
const HUES = ['coral', 'teal', 'yellow', 'blue', 'purple', 'green', 'rose']
const fmt = (n: number) => n.toLocaleString('en-US')

function useMusicStep(preview = true) {
  const uploads = useUploads(true)
  const [source, setSource] = useState<'computer' | 'nest'>('computer')
  const [readingNest, setReadingNest] = useState(false)
  const library = useMusicLibrary(readingNest, uploads.batch?.phase === 'subiendo', preview)
  const read = () => { setReadingNest(true); library.refresh() }
  return { uploads, source, setSource, library, read }
}

export interface MusicStepProps {
  localNest: boolean
  host: React.ReactNode
  onDone: (summary: LibrarySummary | null, albums: string[]) => void
  analyseHere?: boolean
  onAnalyseHere?: (enabled: boolean) => void
}

export function MusicStep({ localNest, host, onDone, analyseHere, onAnalyseHere }: MusicStepProps): React.JSX.Element {
  const model = useMusicStep()
  const { t } = useTranslation()
  return <WizardFrame step="music" host={host} title={t('Your music')}
    show={<AlbumTiles albums={model.library.albums} />}
    actions={<Button className="kob-btn kob-btn--coral" variant="primary" disabled={!model.library.summary && !model.library.failed && model.uploads.batch?.phase !== 'subiendo'} onClick={() => onDone(model.library.summary, model.library.albums)}>{t('Next')}</Button>}
  >
    <MusicContent model={model} localNest={localNest} analyseHere={analyseHere} onAnalyseHere={onAnalyseHere} />
  </WizardFrame>
}

/** The Library page and setup follow-up share the exact same entry paths. */
export function EmptyMusicLibrary({ localNest }: { localNest: boolean }) {
  const { t } = useTranslation()
  const model = useMusicStep(false)
  return <section className="music-empty" aria-label={t('Bring your music')}><h2>{t('Your music')}</h2>{model.library.failed && !model.library.summary && <p>{t('No albums found.')}</p>}<MusicContent model={model} localNest={localNest} emptyLibrary /></section>
}

function MusicContent({ model, localNest, analyseHere: picked, onAnalyseHere, emptyLibrary = false }: { model: ReturnType<typeof useMusicStep>; localNest: boolean; analyseHere?: boolean; onAnalyseHere?: (enabled: boolean) => void; emptyLibrary?: boolean }) {
  const { t } = useTranslation()
  const { uploads, library, source, setSource, read } = model
  const { summary, scanning } = library
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [analyseHere, setAnalyseHere] = useState(false)
  const previousPhase = useRef(uploads.batch?.phase)
  useEffect(() => {
    if (previousPhase.current === 'subiendo' && uploads.batch?.phase === 'terminado') library.refresh()
    previousPhase.current = uploads.batch?.phase
  }, [uploads.batch?.phase, library])
  const canPick = localNest && typeof globalThis.window?.desktopAPI?.selectBaseDir === 'function'
  async function pickLocal() {
    if (!localNest) return
    const picker = globalThis.window?.desktopAPI?.selectBaseDir
    if (!picker) return
    setBusy(true); setFailed(null)
    try {
      const chosen = await picker()
      if (!chosen) return
      await apiPost('/api/set-basedir', { body: { basedir: chosen } })
      try { globalThis.localStorage?.setItem('baseDir', chosen) } catch { /* The server owns the saved root. */ }
      library.refresh()
    } catch (error) {
      logger.warn('Could not set the music folder', { error: String(error) })
      setFailed(t("Couldn't use that folder. It has to be inside your home folder."))
    } finally { setBusy(false) }
  }
  const batch = !localNest ? uploads.batch : null
  const word = batch?.paused || batch?.sendingPaused ? t('Paused') : batch?.phase === 'subiendo' ? t('Uploading') : scanning ? t('Scanning…') : summary ? summary.songs > 0 ? t('Ready') : t('Empty') : t('Loading…')
  return <div className="music-entry">
    <div className="music-folder"><Folder size={18} aria-hidden="true" /><span><code title={t('The nest’s music folder. Flipspin reads any folder layout')}>{summary?.folder ?? '…'}</code><small>{localNest ? t('on this computer') : t('on Nido')}</small></span>
      <span className="music-status" data-tone={word === t('Ready') ? 'ready' : word === t('Empty') ? 'muted' : 'active'} title={summary?.songs === 0 && !localNest ? t('Flipspin reads Nido’s folder in place. If Nido runs in Docker and you expected music here, check that your music folder is mounted.') : undefined}><i />{word}</span>
      {canPick && <button type="button" className="music-button" disabled={busy} onClick={() => void pickLocal()} title={t('Choose another music folder')}>{t('Choose')}</button>}
    </div>
    {(localNest || scanning || (summary?.songs ?? 0) > 0) && <div className="kob-music-counts music-counts">
      <span><b>{summary ? fmt(summary.songs) : '…'}</b> <span>{scanning ? t('songs so far') : t('songs')}</span></span>
      <span><b>{summary ? fmt(summary.albums) : '…'}</b> <span>{t('albums')}</span></span>
      <span><b>{summary ? fmt(summary.artists) : '…'}</b> <span>{t('artists')}</span></span>
    </div>}
    {batch ? <MusicUpload batch={batch} busy={uploads.busy} analyseHere={picked ?? analyseHere} onAnalyseHere={enabled => { setAnalyseHere(enabled); onAnalyseHere?.(enabled) }} />
      : !localNest && library.ready && (summary?.songs === 0 || (emptyLibrary && library.failed)) && <MusicSources source={source} onSource={setSource} onRead={read} busy={uploads.busy || scanning} />}
    {(summary?.songs ?? 0) > 0 && !batch && <LibraryAnalysis />}
    <SpotifyMusicRow onClose={library.refresh} />
    {localNest && summary?.songs === 0 && <button type="button" className="music-button" onClick={library.refresh}>{t('Check again')}</button>}
    {(failed || library.failed || uploads.problem || batch?.error) && <div role="alert" className="kob-alert" title={uploads.problem ?? batch?.error}>
      {failed ?? (library.failed ? t('Could not read the library.') : t('Upload failed'))}
      <button type="button" className="music-button" onClick={() => { setFailed(null); library.refresh() }}>{t('Retry')}</button>
    </div>}
  </div>
}

export function AlbumTiles({ albums }: { albums: string[] }): React.JSX.Element {
  const { t } = useTranslation()
  return <div className="kob-tiles" role="img" aria-label={t('Some albums in the folder')}>
    {(albums.length ? albums.slice(0, 12) : Array<string>(12).fill('')).map((name, index) => <i key={`${name}-${index}`} className={!name ? 'music-ghost' : undefined} style={{ '--_c': `var(--accent-${HUES[index % HUES.length]})` } as CSSProperties}>{name}</i>)}
  </div>
}
