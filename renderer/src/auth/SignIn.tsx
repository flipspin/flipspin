/** Password sign-in mints a device token, allowing recovery when no signed-in device remains.
 * Subsequent requests use that token. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import { CodeSignIn } from './CodeSignIn'
import { apiPost, isApiError } from '../data'
import { logger } from '../ui'
import { bridge } from '../bridge'
import { useDeviceName } from '../setup/deviceName'
import { WizardFrame } from '../onboarding/Shell'
import '../onboarding/nest.css'

export interface SignInProps {
  /** Shown so somebody with two servers knows which one is asking. */
  serverLabel?: string | null
  /** Offered only when this server has no accounts; the caller decides. */
  onCreateInstead?: () => void
  onSignedIn: () => void
}

/**
 * The device label when the shell cannot say what this computer is called
 * (`app:get-device-name` failed, or a browser dev session). A person renames it
 * in Settings if they care, and an honest generic beats an empty column.
 */
const FALLBACK_DEVICE_LABEL = 'Computadora'

export function SignIn({ serverLabel, onCreateInstead, onSignedIn }: SignInProps) {
  const { t } = useTranslation()
  // Use the device name so account lists can distinguish computers.
  const deviceLabel = useDeviceName() ?? FALLBACK_DEVICE_LABEL
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  // The failure itself, worded at render so the sentence follows the language.
  const [problem, setProblem] = useState<{ error: unknown } | null>(null)

  const ready = username.trim().length > 0 && password.length > 0

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const signedIn = await apiPost('/api/login', {
        body: { username: username.trim(), password, deviceLabel },
      })
      const token = (signedIn as { token?: string } | null)?.token
      if (!token) throw new Error('the server returned no token')

      const stored = await bridge().invoke('auth:set', { token, label: deviceLabel })
      if (!stored?.ok) throw new Error('could not store the credential')
      onSignedIn()
    } catch (error) {
      // Never log the username on a failure. A log is the artefact people
      // attach to bug reports, and a failed-login line naming an account is a
      // list of valid names for whoever reads it.
      logger.warn('Sign-in failed', { status: isApiError(error) ? error.status : null })
      setProblem({ error })
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  // Editing the shared username cancels any pending request for the previous account.
  return (
    <WizardFrame title={t("Sign in_infinitive")}
      host={<span className="kob-host"><span className="kob-dot is-ok" />{serverLabel}</span>}
      show={<CodeSignIn key={username.trim()} username={username} deviceLabel={deviceLabel} onSignedIn={onSignedIn} />}
      actions={<button form="kob-sign-in" type="submit" className="kob-btn kob-btn--coral" disabled={!ready || busy}>{busy ? t("Signing in…") : t("Sign in")}</button>}
    >
      <form id="kob-sign-in" className="kob-form kob-password-sign-in" onSubmit={submit}>
        <div className="kob-field">
          <label className="kob-label" htmlFor="sign-in-username">{t("Username_short")}</label>
          <input className="kob-input" id="sign-in-username" value={username} autoComplete="username" autoCapitalize="none" spellCheck={false} onChange={event => setUsername(event.target.value)} />
        </div>
        <div className="kob-field">
          <label className="kob-label" htmlFor="sign-in-password">{t("Password")}</label>
          <input className="kob-input" id="sign-in-password" type="password" value={password} autoComplete="current-password" onChange={event => setPassword(event.target.value)} />
        </div>
        <button type="button" className="kob-forgot-password" title={t("Ask an admin to reset your password in Accounts. If you are the admin, use krobi reset-password on the server.")}>
          {t("Forgot your password?")}
        </button>
        {problem && <div role="alert" className="kob-alert">{explain(problem.error, t)}</div>}
        {onCreateInstead && <button type="button" className="kob-btn kob-btn--ghost" onClick={onCreateInstead}>{t("This nest is new: create the first account")}</button>}
      </form>
    </WizardFrame>
  )
}

/** Keep wrong-username and wrong-password responses identical to avoid exposing which accounts exist. */
function explain(error: unknown, t: TFunction): string {
  if (isApiError(error)) {
    if (error.status === 401) return t("Wrong username or password.")
    if (error.status === 429) {
      return t("Too many attempts in a row. Wait a minute. Devices that already have access keep working.")
    }
    if (error.kind === 'network') {
      return t("Couldn't reach your nest. Check that it's still on._contact")
    }
  }
  return t("Couldn't sign in.")
}
