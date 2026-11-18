import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Monitor } from 'lucide-react'
import { apiGet } from '../data'
import type { UploadBatch, UploadFailure } from '../lib/ipc'
import { formatBytes } from '../settings/format'
import { useCompute } from '../settings/background/data'
import { KeepAwakeSwitch } from '../uploads/KeepAwakeSwitch'
import { isRetryableUpload, uploadActions } from '../uploads/uploadStore'

export function MusicUpload({ batch, busy, analyseHere, onAnalyseHere }: { batch: UploadBatch; busy: boolean; analyseHere: boolean; onAnalyseHere: (enabled: boolean) => void }) {
  const { t } = useTranslation()
  const review = batch.phase === 'resumen'
  const checking = batch.phase === 'revisando'
  const space = useQuery({ queryKey: ['music-onboarding', 'space', batch.id], queryFn: ({ signal }) => apiGet('/api/uploads/space', { signal }), enabled: review, retry: false, })
  const compute = useCompute(review)
  const helper = compute.data?.computers?.find(computer => !computer.nest && ['idle', 'working'].includes(computer.state) && computer.jobs?.includes('analysis'))
  const files = batch.files
  const already = files.filter(file => file.already || file.state === 'ya-estaba').length
  const unsupported = files.filter(file => file.state === 'no-apta').length
  const candidates = files.filter(file => !file.already && file.state !== 'ya-estaba' && file.state !== 'no-apta')
  const uploaded = candidates.filter(file => file.state === 'agregada').length
  const bytes = candidates.reduce((total, file) => total + file.bytes, 0)
  const sent = candidates.reduce((total, file) => total + file.offset, 0)
  const issues = files.filter(file => file.reason)
  const retryable = issues.filter(isRetryableUpload).length
  const enough = space.data != null && bytes + space.data.floorBytes <= space.data.freeBytes
  const reason = !space.data ? space.isFetching ? t('Checking space on Nido…') : t('Could not read space on Nido. Try again.') : !enough ? t('Not enough space on Nido') : undefined
  const offerAnalysis = candidates.length > 25 && compute.isSuccess && !helper
  const localAnalysis = analyseHere && offerAnalysis
  useEffect(() => {
    if (analyseHere && compute.isSuccess && !offerAnalysis) onAnalyseHere(false)
  }, [analyseHere, compute.isSuccess, offerAnalysis, onAnalyseHere])
  const failureWord = (failure: UploadFailure) => ({
    'not-audio': t('Not audio'), 'changed': t('Changed while uploading'), 'unreadable': t("Can't read"), 'damaged': t('Damaged'),
    'no-es-audio': t('Not audio'), 'archivo-danado': t('Damaged'),
    'muy-grande': t('Too large'), 'sin-espacio': t('Nest out of space'), 'fallo-subida': t('Upload failed'),
  })[failure]
  const paused = batch.paused ? {
    asleep: t('this computer was asleep'), 'no-network': t('no network'), 'nest-unreachable': t('Nido is unreachable'),
    'signed-out': t('signed out'), 'no-space': t('no space on Nido'), 'drive-missing': t('drive missing'),
  }[batch.paused] : batch.sendingPaused ? t('uploads paused') : null
  return <>
    <section className="music-panel" aria-label={review || checking ? t('Review') : t('Upload music')}>
      {(review || checking) && <div className="music-line"><Monitor size={18} aria-hidden="true" />
        <code title={t('The folder you picked stays on this computer.')}>{batch.folder ?? t('Folder on this computer')}</code>
        <button type="button" className="music-button" disabled={busy} onClick={() => void uploadActions.pick('folder', 'inline')}>{t('Change')}</button>
      </div>}
      {checking ? <>
        <div className="music-line"><b>{t('Reviewing…')}</b><span>{t('{{n}} of {{total}}', { n: batch.reviewed ?? 0, total: batch.total ?? 0 })}</span></div>
        <progress aria-label={t('Reviewing…')} max={Math.max(1, batch.total ?? 0)} value={batch.reviewed ?? 0} />
      </> : review ? <>
        <table className="music-review"><tbody>
          <tr><th>{t('To upload')}</th><td>{t('{{n}} songs · {{bytes}}', { count: candidates.length, n: candidates.length.toLocaleString(), bytes: formatBytes(bytes) })}</td></tr>
          <tr><th title={t('Files already on Nido are not sent again.')}>{t('Already on Nido')}</th><td>{already}</td></tr>
          <tr><th>{t('Not supported')}</th><td>{unsupported}</td></tr>
          <tr><th>{t('Space on Nido')}</th><td title={reason}>{space.data ? !enough ? t('Needs {{needed}} · {{free}} free', { needed: formatBytes(bytes + space.data.floorBytes), free: formatBytes(space.data.freeBytes) }) : t('{{bytes}} free', { bytes: formatBytes(space.data.freeBytes) }) : <button type="button" className="music-button" onClick={() => void space.refetch()}>{space.isFetching ? t('Checking…') : t('Retry')}</button>}</td></tr>
          <tr><th>{t('Analysis')}</th><td>{localAnalysis ? t('On this computer, as songs arrive') : helper ? t('On {{name}}', { name: helper.name }) : t('On Nido, as songs arrive')}</td></tr>
        </tbody></table>
        {offerAnalysis && <div className="music-analysis-box">
          <Monitor size={20} aria-hidden="true" /><span><b>{t('Analyse on this computer')}</b><small title={t('Selected in the Engines step. Nothing is installed here.')}>{t('Installs the Analysis add-on on this computer · ≈ 170 MB')}</small></span>
          <input className="music-toggle" type="checkbox" role="switch" aria-label={t('Analyse on this computer')} checked={analyseHere} onChange={event => onAnalyseHere(event.target.checked)} />
        </div>}
        <KeepAwakeSwitch />
      </> : <>
        <div className="music-line"><b>{batch.phase === 'terminado' ? t('Uploaded from this computer') : t('Uploading from this computer')}</b><span>{t('{{n}} of {{total}}', { n: uploaded, total: candidates.length })}</span></div>
        <progress aria-label={t('Upload music')} value={batch.phase === 'terminado' ? 1 : sent / Math.max(1, bytes)} max={1} />
        <div className="music-upload-counts"><span><b>{uploaded}</b> {t('uploaded')}</span><span><b>{already}</b> {t('already there')}</span><span><b>{unsupported}</b> {t('not supported')}</span></div>
        <div className="music-line"><span title={t('Analysis runs on Nido or an online computer with the Analysis add-on.')}>{t('Analysing as songs arrive')}</span>
          {batch.phase === 'subiendo' && <button type="button" className="music-button" title={t('Uploaded songs stay in your library')} disabled={busy} onClick={() => void uploadActions.stop()}>{t('Stop')}</button>}</div>
        {paused && <span className="music-status" role="status" title={t('Continues automatically when the cause clears, from where it stopped.')}><i />{t('Paused · {{cause}}', { cause: paused })}</span>}
        {batch.phase === 'terminado' && issues.length > 0 && <div className="music-issues">
          <b>{t('{{n}} songs need a look', { count: issues.length, n: issues.length })}</b>
          {issues.map(file => <div className="music-issue" key={file.id}><span title={file.name}>{file.name}</span><span className="music-status" title={file.reason ? failureWord(file.reason) : undefined}><i />{file.reason && failureWord(file.reason)}</span></div>)}
          {retryable > 0 && <button type="button" className="music-button" disabled={busy} onClick={() => void uploadActions.retry()}>{t('Retry {{n}}', { n: retryable })}</button>}
        </div>}
        <KeepAwakeSwitch />
      </>}
    </section>
    {review && <div className="music-action" title={reason}><button type="button" className="music-button music-primary" title={reason} disabled={busy || !enough || candidates.length + already === 0} onClick={() => void uploadActions.start()}>{t('Upload {{n}} songs', { count: candidates.length, n: candidates.length.toLocaleString() })}</button></div>}
  </>
}
