import { useId } from 'react'
import { Monitor, Server } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { hasBridge } from '../bridge'
import { uploadActions } from '../uploads/uploadStore'
import './music.css'

export function MusicSources({ source, onSource, onRead, busy }: { source: 'computer' | 'nest'; onSource: (source: 'computer' | 'nest') => void; onRead: () => void; busy: boolean }) {
  const { t } = useTranslation()
  const group = useId()
  return <>
    <div className="music-sources" role="radiogroup" aria-label={t('Where your music is')}>
      {(['computer', 'nest'] as const).map(value => <label key={value} className="music-source" data-selected={source === value} title={value === 'computer' ? t('Flipspin copies music to Nido, filed by artist and album. Files already on Nido are skipped; your files here stay where they are.') : t('Flipspin reads Nido’s folder in place. If Nido runs in Docker and you expected music here, check that your music folder is mounted.')}>
        <input type="radio" name={group} value={value} checked={source === value} onChange={() => { onSource(value); if (value === 'nest') onRead() }} />
        {value === 'computer' ? <Monitor size={26} aria-hidden="true" /> : <Server size={26} aria-hidden="true" />}
        <b>{value === 'computer' ? t('On this computer') : t('Already on Nido')}</b>
        <span title={value === 'computer' ? t('Flipspin copies music to Nido, filed by artist and album. Files already on Nido are skipped; your files here stay where they are.') : t('Flipspin reads Nido’s folder in place. If Nido runs in Docker and you expected music here, check that your music folder is mounted.')}>{value === 'computer' ? t('Upload to Nido') : t('Read Nido’s folder')}</span>
      </label>)}
    </div>
    <div className="music-action"><button type="button" className="music-button music-primary" disabled={busy || (source === 'computer' && !hasBridge())}
      onClick={() => { if (source === 'computer') void uploadActions.pick('folder', 'inline'); else onRead() }}>{source === 'computer' ? t('Choose a folder…') : t('Check again')}</button></div>
  </>
}
