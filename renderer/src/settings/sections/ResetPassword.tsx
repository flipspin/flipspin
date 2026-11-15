import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiPost, isApiError } from '../../data'
import { Modal } from '../parts'

export function ResetPassword({ id, label, onClose }: { id: string; label: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function reset() {
    setBusy(true)
    setProblem(null)
    try {
      await apiPost('/api/users/{user_id}/password', { params: { path: { user_id: id } }, body: { newPassword: password } })
      setPassword('')
      setAgain('')
      setDone(true)
    } catch (error) {
      setProblem(isApiError(error) && error.status === 409
        ? t("The account must choose a username before its password can be reset.")
        : t("Could not reset the password. Use at least 10 characters and try again."))
    } finally { setBusy(false) }
  }

  return <Modal title={t("Reset password for {{name}}", { name: label })} onClose={busy ? () => {} : onClose}>
    {done ? <>
      <p role="status">{t("Password reset. Their devices remain signed in.")}</p>
      <button className="ks-btn" onClick={onClose}>{t("Done")}</button>
    </> : <form onSubmit={event => { event.preventDefault(); if (!busy && password.length >= 10 && password === again) void reset() }}>
      <label className="z-field"><span className="z-label">{t("New password")}</span>
        <input className="ks-field" type="password" autoComplete="new-password" value={password} minLength={10} maxLength={256} onChange={event => setPassword(event.target.value)} />
      </label>
      <label className="z-field"><span className="z-label">{t("Repeat the password")}</span>
        <input className="ks-field" type="password" autoComplete="new-password" value={again} aria-invalid={again !== '' && again !== password} onChange={event => setAgain(event.target.value)} />
      </label>
      {again && again !== password && <p className="z-err">{t("They don’t match")}</p>}
      {problem && <p role="alert" className="z-err">{problem}</p>}
      <div className="settings-modal__do">
        <button type="button" className="ks-btn" disabled={busy} onClick={onClose}>{t("Cancel")}</button>
        <button type="submit" className="ks-btn ks-btn--go" disabled={busy || password.length < 10 || password !== again}>{t("Reset password")}</button>
      </div>
    </form>}
  </Modal>
}
