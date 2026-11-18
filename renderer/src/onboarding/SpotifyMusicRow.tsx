import { lazy, Suspense, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/react/components/Button'
import { ModalLayer } from '../ui/react/components/ModalLayer'
import { SpotifyDataLink } from '../spotify-import/SpotifyDataHelp'
const SpotifyExportImport = lazy(() => import('../spotify-import/SpotifyExportImport'))

export function SpotifyMusicRow({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [importing, setImporting] = useState(false)
  const close = () => { setImporting(false); onClose() }
  return <>
    <div className="music-spotify">
      <span><b title={t('Reads the playlists in the file Spotify sends you; you review matches before anything downloads')}>{t('Spotify playlists')}</b><small>{t('.zip from "Download your data"')}</small></span>
      <SpotifyDataLink className="music-button" />
      <button type="button" className="music-button" onClick={() => setImporting(true)}>{t('Import_verb')}</button>
    </div>
    {importing && <ModalLayer className="krobi-setup z-root krobi-onboarding kob-import-dialog" data-profile="night" style={{ '--kob-hue': 'var(--accent-yellow)' } as CSSProperties} aria-label={t('Import from Spotify')} onClose={close}>
      <div className="kob-import-head"><h2>{t('Import from Spotify')}</h2><Button className="kob-btn" onClick={close}>{t('Close')}</Button></div>
      <Suspense fallback={<span role="status">{t('Loading…')}</span>}><SpotifyExportImport embedded /></Suspense>
    </ModalLayer>}
  </>
}
