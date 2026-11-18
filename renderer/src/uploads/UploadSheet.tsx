import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Folder, Upload, X } from 'lucide-react'
import { Modal } from '../settings/parts'
import { formatBytes, formatCount } from '../settings/format'
import type { UploadBatch, UploadChoice, UploadFailure } from '../lib/ipc'
import '../ui/tokens/modern.css'
import '../ui/modern-primitives.css'
import './uploads.css'
import { isRetryableUpload } from './uploadStore'

type Props = {
  batch: UploadBatch | null
  problem?: string | null
  busy?: boolean
  onPick: (kind: 'folder' | 'files') => void
  onStart: (choice: UploadChoice) => void
  onStop: () => void
  onRetry: () => void
  onClose: () => void
}
export function UploadSheet({ batch, problem, busy, onPick, onStart, onStop, onRetry, onClose }: Props) {
  const { t } = useTranslation()
  const [choice, setChoice] = useState<UploadChoice>('use-nest')
  const phase = batch?.phase ?? 'elegir'
  const files = batch?.files ?? []
  const already = files.filter(f => f.already || f.state === 'ya-estaba').length
  const invalid = files.filter(f => f.state === 'no-apta').length
  const added = files.filter(f => f.state === 'agregada').length
  const uploaded = files.filter(f => f.state === 'agregada' && !f.already).length
  const uploadFiles = files.filter(f => !f.already && f.state !== 'ya-estaba' && f.state !== 'no-apta')
  const pending = files.filter(f => ['por-subir', 'subiendo', 'importando'].includes(f.state))
  const failures = files.filter(f => f.reason)
  const duplicates = files.filter(f => f.duplicate).length
  const bytes = files.reduce((n, f) => n + f.bytes, 0)
  const sent = uploadFiles.reduce((n, f) => n + f.offset, 0)
  const uploadBytes = uploadFiles.reduce((n, f) => n + f.bytes, 0)
  const total = Math.max(1, files.length)
  const failureWord = (kind: UploadFailure) => ({
    'not-audio': t("Not audio"), changed: t("Changed while uploading"), unreadable: t("Can't read"), damaged: t("Damaged"),
    'no-es-audio': t("Not audio"), 'archivo-danado': t("Damaged file"),
    'muy-grande': t("Too large"), 'sin-espacio': t("Nest out of space"), 'fallo-subida': t("Upload failed"),
  })[kind]
  const progress = phase === 'revisando' ? (batch?.reviewed ?? 0) / Math.max(1, batch?.total ?? 1) : sent / Math.max(1, bytes)
  return <div className="krobi-upload-island">
    <Modal title={t("Upload music")} profile="modern" className="krobi-modern up-dialog" onClose={onClose} heading={id => <div className="up-head">
      <span className="zm-av zm-av--lg" aria-hidden><Upload size={22} strokeWidth={2.5} /></span>
      <div className="up-heading"><h3 id={id}>{t("Upload music")}</h3>
        {files.length > 0 && <span className="up-facts" title={t("Files are copied; the files on this computer stay unchanged")}>{t("{{n}} files · {{bytes}}", { n: formatCount(files.length), bytes: formatBytes(bytes) })}</span>}
      </div>
      <button type="button" className="up-close" aria-label={t("Close")} onClick={onClose}><X size={18} strokeWidth={2.5} /></button>
    </div>}>
      {phase === 'elegir' && <div className="up-drop">
        <Folder size={32} strokeWidth={2.5} aria-hidden />
        <b>{t("Drop songs or folders")}</b>
        <div className="up-actions"><button type="button" className="zm-act" disabled={busy} onClick={() => onPick('folder')}>{t("Choose folder")}</button><button type="button" className="zm-act" disabled={busy} onClick={() => onPick('files')}>{t("Choose files")}</button></div>
      </div>}
      {phase === 'revisando' && <div className="up-summary">
        <div className="up-line"><span>{t("Checking which files are already in the nest…")}</span><b>{t("{{n}} of {{total}}", { n: batch?.reviewed ?? 0, total: batch?.total ?? 0 })}</b></div>
        <progress aria-label={t("Scanning")} value={progress} max={1} />
      </div>}
      {['resumen', 'subiendo', 'terminado'].includes(phase) && <div className="up-summary" aria-live="polite">
        <div className="up-big"><b>{phase === 'subiendo' ? t("{{n}} of {{total}}", { n: uploaded, total: uploadFiles.length }) : formatCount(phase === 'terminado' ? added : files.length)}</b>
          <span>{phase === 'resumen' ? t("files") : phase === 'terminado' ? t("in your library") : t("uploaded · {{sent}} of {{bytes}}", { sent: formatBytes(sent), bytes: formatBytes(uploadBytes) })}</span></div>
        <div className="up-bar" aria-hidden><i style={{ width: `${already / total * 100}%`, background: 'var(--teal)' }} /><i style={{ width: `${(phase === 'subiendo' || phase === 'terminado' ? uploaded : pending.length) / total * 100}%`, background: 'var(--blue)' }} /><i style={{ flex: 1, background: 'var(--line-med)' }} /></div>
        <div className="zm-key up-key"><span title={t("Added to your library without uploading")}><i style={{ background: 'var(--teal)' }} /><b>{already}</b> {t("already here")}</span><span><i style={{ background: 'var(--blue)' }} /><b>{phase === 'terminado' ? uploaded : pending.length}</b> {phase === 'terminado' ? t("uploaded") : t("to upload")}</span><span><i style={{ background: 'var(--ink-4)' }} /><b>{invalid}</b> {t("ineligible")}</span></div>
      </div>}
      {phase === 'resumen' && duplicates > 0 && <div className="up-duplicates">
        <b title={t("Same song and duration as one in the nest, in a different file")}>{t("{{n}} are another version of a song in the nest", { n: duplicates })}</b>
        <div className="up-segment" role="radiogroup" aria-label={t("Other versions")} onKeyDown={event => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            const next = event.key === 'Home' ? 'use-nest' : event.key === 'End' ? 'keep-both' : choice === 'use-nest' ? 'keep-both' : 'use-nest'
            setChoice(next)
            event.currentTarget.querySelector<HTMLButtonElement>(`[data-choice="${next}"]`)?.focus()
          }
        }}>
          {(['use-nest', 'keep-both'] as const).map(option => <button key={option} type="button" role="radio" data-choice={option} aria-checked={choice === option} tabIndex={choice === option ? 0 : -1} onClick={() => setChoice(option)}>{option === 'use-nest' ? t("Use the nest’s") : t("Keep both")}</button>)}
        </div>
      </div>}
      {phase === 'subiendo' && batch?.current && <code className="up-current">{batch.current}</code>}
      {phase === 'terminado' && failures.length > 0 && <div className="up-failures">
        <div className="up-line"><b>{t("{{n}} were not uploaded", { n: failures.length })}</b>{failures.some(isRetryableUpload) && <button type="button" className="zm-act" disabled={busy} onClick={onRetry}>{t("Retry")}</button>}</div>
        {(['not-audio', 'changed', 'unreadable', 'damaged', 'fallo-subida', 'sin-espacio', 'no-es-audio', 'archivo-danado', 'muy-grande'] as const).map(kind => {
          const group = failures.filter(f => f.reason === kind)
          return group.length > 0 && <div key={kind} className="up-failure-group"><span className="up-status" title={kind === 'muy-grande' && batch?.maxBytes ? t("The nest accepts files up to {{bytes}}", { bytes: formatBytes(batch.maxBytes) }) : undefined}><i />{failureWord(kind)} <b>{group.length}</b></span>{group.map(f => <code key={f.sha256}>{f.name}</code>)}</div>
        })}
      </div>}
      {(problem || batch?.error) && <span role="alert" className="up-status"><i />{batch?.error === 'sin-espacio' ? t("Nest out of space") : t("Upload failed")}</span>}
      <div className="up-foot">
        {phase === 'subiendo' ? <button type="button" className="zm-act" title={t("Uploaded songs stay in your library")} disabled={busy} onClick={onStop}>{t("Stop")}</button>
          : phase === 'terminado' ? <button type="button" className="zm-ink" onClick={onClose}>{t("Done")}</button>
          : <><button type="button" className="zm-act" onClick={onStop}>{t("Cancel")}</button>{phase === 'resumen' && <button type="button" className="zm-ink" disabled={busy || already + pending.length === 0} onClick={() => onStart(choice)}>{t("Add {{already}} and upload {{pending}}", { already, pending: pending.length })}</button>}</>}
      </div>
    </Modal>
  </div>
}
