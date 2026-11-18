import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { apiGet, apiPost, isApiError, queryKeys } from '../../data'
import { MIN_PASSWORD } from '../../auth/CreateAccount'
import { Modal } from '../parts'

export function ResetPassword({ id, label, onClose }: { id: string; label: string; onClose: () => void }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  // An account made with only a token has no username yet; the owner gives it one here.
  // The nest says so before anything is typed, so the field is there from the start.
  const [needsUsername, setNeedsUsername] = useState<boolean | null>(null)
  const [username, setUsername] = useState('')

  useEffect(() => {
    let live = true
    apiGet('/api/users/{user_id}/sign-in', { params: { path: { user_id: id } } })
      .then(data => {
        if (!live) return
        setNeedsUsername(data.username == null)
        if (data.username == null) setUsername(suggestUsername(label))
      })
      .catch(() => { if (live) setNeedsUsername(false) })
    return () => { live = false }
  }, [id, label])

  async function reset() {
    setBusy(true)
    setProblem(null)
    try {
      await apiPost('/api/users/{user_id}/password', { params: { path: { user_id: id } }, body: { newPassword: password, ...(needsUsername ? { username: username.trim() } : {}) } })
      setPassword('')
      setAgain('')
      setDone(true)
      // The account panel shows the new username and password state at once.
      void queryClient.invalidateQueries({ queryKey: queryKeys.household.all })
    } catch (error) {
      if (isApiError(error) && error.status === 409 && !needsUsername) {
        // The account lost its name between opening and saving: ask for one now.
        setNeedsUsername(true)
        setUsername(suggestUsername(label))
      } else {
        setProblem(isApiError(error) && error.status === 409
          ? t("That username is taken")
          : t("Could not reset the password. Use at least 8 characters and try again."))
      }
    } finally { setBusy(false) }
  }

  return <Modal title={t("Reset password for {{name}}", { name: label })} onClose={busy ? () => {} : onClose}>
    {done ? <>
      <p role="status">{t("Password reset. Their devices remain signed in.")}</p>
      <button className="ks-btn" onClick={onClose}>{t("Done")}</button>
    </> : <form onSubmit={event => { event.preventDefault(); if (!busy && password.length >= MIN_PASSWORD && password === again && (!needsUsername || username.trim().length >= 3)) void reset() }}>
      {needsUsername ? <label className="z-field"><span className="z-label" title={t("The name they type to sign in")}>{t("Username")}</span>
        <input className="ks-field" value={username} maxLength={64} autoComplete="off" spellCheck={false} onChange={event => setUsername(event.target.value)} />
      </label> : null}
      <label className="z-field"><span className="z-label">{t("New password")}</span>
        <input className="ks-field" type="password" autoComplete="new-password" value={password} minLength={MIN_PASSWORD} maxLength={256} onChange={event => setPassword(event.target.value)} />
      </label>
      <label className="z-field"><span className="z-label">{t("Repeat the password")}</span>
        <input className="ks-field" type="password" autoComplete="new-password" value={again} aria-invalid={again !== '' && again !== password} onChange={event => setAgain(event.target.value)} />
      </label>
      {again && again !== password && <p className="z-err">{t("They don’t match")}</p>}
      {problem && <p role="alert" className="z-err">{problem}</p>}
      <div className="settings-modal__do">
        <button type="button" className="ks-btn" disabled={busy} onClick={onClose}>{t("Cancel")}</button>
        <button type="submit" className="ks-btn ks-btn--go" disabled={busy || needsUsername === null || password.length < MIN_PASSWORD || password !== again || (needsUsername && username.trim().length < 3)}>{t("Reset password")}</button>
      </div>
    </form>}
  </Modal>
}

/** A starting username from the account's name: lower case, letters, digits, dots, dashes and underscores. */
function suggestUsername(label: string): string {
  return label.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').replace(/^[^a-z0-9]+/, '').slice(0, 32)
}
