import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Laptop, X } from 'lucide-react'
import { apiPost, isApiError } from '../data'
import { openSettings } from '../shell/ServerBadge'
import type { SignInRequest } from './signInRequests'
import { useSignInTheme } from './signInTheme'
import '../ui/tokens/base.css'
import '../ui/tokens/personal.css'
import '../ui/primitives.css'
import './sign-in-request.css'

export function SignInRequestSheet({ request, account, typed = false, onClose, onDecided }: {
  request: SignInRequest
  account: string
  typed?: boolean
  onClose: () => void
  onDecided: () => void
}) {
  const { t } = useTranslation()
  const theme = useSignInTheme()
  const dialog = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState(false)
  const [approved, setApproved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const opener = document.activeElement
    const element = dialog.current
    if (element?.showModal) element.showModal()
    else element?.setAttribute('open', '')
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(timer)
      element?.close?.()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  async function decide(decline: boolean) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      if (typed) {
        if (decline) await apiPost('/api/me/sign-in-code/{code}/decline', { params: { path: { code: request.code } } })
        else await apiPost('/api/me/sign-in-code', { body: { code: request.code } })
      } else if (decline) {
        await apiPost('/api/me/sign-in-requests/{request_id}/decline', { params: { path: { request_id: request.id } } })
      } else {
        await apiPost('/api/me/sign-in-requests/{request_id}/approve', { params: { path: { request_id: request.id } } })
      }
      onDecided()
      if (decline) onClose()
      else setApproved(true)
    } catch (cause) {
      setError(isApiError(cause) && cause.status === 429 ? t("Too many attempts. Wait a minute.")
        : t("Code unavailable. Check that it is correct and has not expired."))
    } finally { setBusy(false) }
  }

  const expired = now >= Date.parse(request.expiresAt)
  return createPortal(<dialog ref={dialog} className="krobi-setup z-root krobi-sign-in ksr-dialog" data-profile="krobi" data-theme={theme}
    aria-label={approved ? t("{{device}} connected", { device: request.deviceLabel }) : t("wants to sign in")} aria-modal="true"
    onCancel={event => { event.preventDefault(); if (!busy) onClose() }}
    onKeyDown={event => event.stopPropagation()}>
    <div className="ksr-sheet">
      <button className="z-btn z-btn--ghost ksr-close" aria-label={t("Close")} onClick={onClose} disabled={busy}><X size={18} aria-hidden="true" /></button>
      {approved ? <div className="ksr-ok" role="status"><span className="ksr-okmark" aria-hidden="true">✓</span><h2>{t("{{device}} connected", { device: request.deviceLabel })}</h2><button className="z-btn z-btn--ghost" type="button" onClick={() => { onClose(); openSettings('dispositivos') }}>{t("My devices")}</button></div> : <>
        <span className="z-eyebrow">{t("wants to sign in")}</span>
        <div className="ksr-device"><span className="ksr-device-icon"><Laptop aria-hidden="true" /></span><div><h2>{request.deviceLabel}</h2><span className="ksr-muted ksr-mono">{request.network === 'local' ? t("local network") : t('VPN')} · {t("{{seconds}} s ago", { seconds: Math.max(0, Math.floor((now - Date.parse(request.createdAt)) / 1000)) })}</span></div></div>
        <dl className="ksr-kv"><div><dt>{t("Account")}</dt><dd>{account}</dd></div><div><dt>{t("Code")}</dt><dd className="ksr-code">{request.code.slice(0, 3)}-{request.code.slice(3)}</dd></div></dl>
        {(error || expired) && <p role="alert" className="z-err">{error ?? t("The code expired.")}</p>}
        <div className="ksr-actions"><button className="z-btn" disabled={busy || expired} onClick={() => void decide(true)}>{t("Decline")}</button><button className="z-btn z-btn--coral" disabled={busy || expired} onClick={() => void decide(false)}>{t("Approve")}</button></div>
      </>}
    </div>
  </dialog>, document.body)
}
