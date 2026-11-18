import { useTranslation } from 'react-i18next'
import { hasBridge } from '../bridge'
import { uploadActions, useUploads } from './uploadStore'
import { Switch } from '../settings/parts'
import './keep-awake.css'

export function KeepAwakeSwitch({ settings = false }: { settings?: boolean }) {
  const { t } = useTranslation()
  const { keepAwake, preferenceBusy, batch, problem } = useUploads()
  const label = settings ? t('Keep Flipspin and this computer awake during uploads') : t('Keep Flipspin and this computer awake until the upload is done')
  const details = t('Closing the window keeps Flipspin in the menu bar until the upload ends. Closing the lid or choosing Sleep pauses it; uploading resumes when this computer wakes. Off: closing the window quits Flipspin; the upload resumes next time.')
  if (settings) return <div className="ks-row">
    <div className="ks-l"><b title={details}>{label}</b>
      {batch?.awake === 'unsupported' && <span title={t('Uploading continues, but this system could not prevent idle sleep.')}>{t('Sleep not blocked')}</span>}
      {problem && <span role="alert" title={problem}>{t('Could not save the change')}</span>}</div>
    <div className="ks-c"><Switch label={label} title={details} checked={keepAwake ?? true} disabled={!hasBridge() || keepAwake == null || preferenceBusy}
      onChange={next => void uploadActions.keepAwake(next)} /></div>
  </div>
  return <div className="music-awake">
    <label title={details}><span>{label}</span><input className="music-toggle" type="checkbox" role="switch" aria-label={label}
      checked={keepAwake ?? true} disabled={!hasBridge() || keepAwake == null || preferenceBusy}
      onChange={event => void uploadActions.keepAwake(event.target.checked)} /></label>
    {batch?.awake === 'unsupported' && <span title={t('Uploading continues, but this system could not prevent idle sleep.')}>{t('Sleep not blocked')}</span>}
    {settings && problem && <span role="alert" title={problem}>{t('Could not save the change')}</span>}
  </div>
}
