/** Desktop account deletion, in Flipspin's scoped modern dialog. */
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Trash2, UserRoundX, X } from 'lucide-react'

import { bridge } from '../../bridge'
import { isApiError } from '../../data'
import { deleteAccount, useDeletionPreview } from '../../data/hooks/use-deletion-preview'
import type { PairedDevice } from '../../pairing'
import { doLabel, facts, optionB, toast as deletionToast, type DeleteChoice } from '../deleteAccount'
import { formatBytes, formatCount } from '../format'
import { Modal, useToast } from '../parts'
import { missingWord } from '../../ui/react/components/missingWords'

/** Keep numbers prominent without coupling translated sentence order to markup. */
function Numbers({ text }: { text: string }): React.JSX.Element {
  return <>{text.split(/(\d[\d.,]*)/u).map((part, index) => /^\d/u.test(part) ? <b key={index}>{part}</b> : part)}</>
}

export function DeleteAccount({ person, own, onClose, onDeleted }: {
  person: PairedDevice
  own: boolean
  onClose: () => void
  onDeleted: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const notify = useToast()
  const preview = useDeletionPreview(person.id)
  const [choice, setChoice] = useState<DeleteChoice>('account')
  const [busy, setBusy] = useState(false)
  const inFlight = useRef(false)
  const [lastAdmin, setLastAdmin] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const group = useRef<HTMLDivElement>(null)
  const reasonId = useId()
  const data = preview.isError ? null : preview.data ?? null
  const availability = optionB(data)
  const selected = availability.enabled ? choice : 'account'
  const pending = (preview.isPending || preview.isFetching) && data === null
  const reason = availability.why === 'none'
    ? t("{{name}} has no songs of their own in the nest.", { name: person.label })
    : data
      ? t("Only songs that {{name}} downloaded and no other account saved are deleted from the nest. The rest stay.", { name: person.label })
      : t("The nest did not respond, so no songs will be deleted")
  const title = lastAdmin ? t("Your account cannot be deleted") : own ? t("Delete your account?") : t("Delete {{name}}’s account?", { name: person.label })
  const close = () => { if (!inFlight.current) onClose() }

  const remove = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setProblem(null)
    try {
      const result = await deleteAccount(person.id, selected === 'songs')
      notify(deletionToast(person.label, result))
      onClose()
      onDeleted()
      if (own) await bridge().invoke('auth:clear', undefined).catch(() => undefined)
    } catch (error) {
      if (isApiError(error) && error.status === 422) setLastAdmin(true)
      else setProblem(t("Could not delete · it keeps access"))
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Modal title={title} profile="modern" busy={busy} className="krobi-modern da-dialog" onClose={close} heading={titleId => (
      <div className="da-head">
        <span className="zm-av zm-av--lg" aria-hidden>{(person.label.trim()[0] ?? '?').toUpperCase()}</span>
        <div className="da-head__text">
          <h3 id={titleId}>{title}</h3>
          {!lastAdmin && <span className="da-facts" aria-live="polite" title={!data && !pending ? reason : undefined}><Numbers text={data ? facts(data) : pending ? t("… devices · … songs · … playlists") : missingWord('nodata')} /></span>}
        </div>
        {!lastAdmin && <button type="button" className="da-close" aria-label={t("Close")} title={t("Close")} disabled={busy} onClick={close}><X aria-hidden /></button>}
      </div>
    )}>
      {lastAdmin ? <>
        <p className="da-reason" role="alert">{t("It is the nest’s last admin account: without it, nobody could create or remove accounts.")}</p>
        <div className="da-foot"><button type="button" className="zm-ink" autoFocus onClick={close}>{t("Got it")}</button></div>
      </> : <>
        <div className="da-options" role="radiogroup" aria-label={t("What to delete")} ref={group} onKeyDown={event => {
          if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
          event.preventDefault()
          if (busy) return
          const next = availability.enabled && (event.key === 'End' || (event.key !== 'Home' && selected === 'account')) ? 'songs' : 'account'
          setChoice(next)
          group.current?.querySelector<HTMLButtonElement>(`[data-choice="${next}"]`)?.focus()
        }}>
          <button type="button" role="radio" data-choice="account" aria-checked={selected === 'account'} tabIndex={selected === 'account' ? 0 : -1} disabled={busy}
            className={`zm-option${selected === 'account' ? ' zm-option--sel' : ''}`} onClick={() => setChoice('account')}>
            <span className="zm-option__icon" aria-hidden><UserRoundX /></span>
            <span className="zm-option__body">
              <span className="zm-option__title">{t("Only the account")}<span className="zm-option__check" aria-hidden /></span>
              {data ? <span className="zm-key">
                <span><Numbers text={t("{{n}} songs stay in the nest", { count: data.songs, n: formatCount(data.songs) })} /></span>
                <span><Numbers text={t("{{n}} playlists move to your account", { count: data.playlists, n: formatCount(data.playlists) })} /></span>
              </span> : pending ? <span className="zm-skel" aria-hidden /> : null}
            </span>
          </button>
          <div className="da-choice" tabIndex={!availability.enabled && !busy && !pending ? 0 : undefined} aria-label={!availability.enabled && !pending ? reason : undefined}>
            <button type="button" role="radio" data-choice="songs" aria-checked={selected === 'songs'} tabIndex={selected === 'songs' ? 0 : -1}
              disabled={busy || !availability.enabled} aria-describedby={pending ? undefined : reasonId}
              className={`zm-option${selected === 'songs' ? ' zm-option--sel' : ''}`} onClick={() => setChoice('songs')}>
              <span className="zm-option__icon" aria-hidden><Trash2 /></span>
              <span className="zm-option__body">
                <span className="zm-option__title"><span>{t("The account and its songs")} <span className="zm-info" aria-hidden>i</span></span><span className="zm-option__check" aria-hidden /></span>
                {data && availability.enabled ? <>
                  <span className="zm-progress" aria-hidden style={{ '--_v': `${data.songs > 0 ? data.removable.count / data.songs * 100 : 0}%` } as React.CSSProperties}><i /></span>
                  <span className="zm-key">
                    <span><i className="da-dot--removed" aria-hidden /><Numbers text={t("{{n}} deleted · {{size}}", { count: data.removable.count, n: formatCount(data.removable.count), size: formatBytes(data.removable.bytes) })} /></span>
                    <span><i className="da-dot--kept" aria-hidden /><Numbers text={t("{{n}} stay · other accounts have them", { count: data.kept, n: formatCount(data.kept) })} /></span>
                    <span><Numbers text={t("{{n}} playlists are deleted", { count: data.playlists, n: formatCount(data.playlists) })} /></span>
                  </span>
                </> : pending ? <><span className="zm-progress" aria-hidden /><span className="zm-skel" aria-hidden /></> : <span className="zm-key">{data ? t("0 songs only theirs") : <span title={reason}>{t("The nest did not answer")}</span>}</span>}
              </span>
            </button>
            {!pending && <span role="tooltip" id={reasonId} className="da-tooltip">{reason}</span>}
          </div>
        </div>
        {problem && <p className="da-reason da-reason--error" role="alert">{problem}</p>}
        <div className="da-foot">
          {preview.isError && <button type="button" className="zm-act da-retry" disabled={busy || pending} onClick={() => { setChoice('account'); void preview.refetch() }}>{t("Retry")}</button>}
          <button type="button" className="zm-act" disabled={busy} onClick={close}>{t("Cancel")}</button>
          <button type="button" className="ks-btn ks-btn--danger" disabled={busy} aria-busy={busy} onClick={() => void remove()}>{busy ? t("Deleting…") : doLabel(selected, data?.removable.count ?? 0)}</button>
        </div>
      </>}
    </Modal>
  )
}
