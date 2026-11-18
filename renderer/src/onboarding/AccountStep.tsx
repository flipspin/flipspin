/** The claim token reaches the shell before setup continues because the server
 * retains only its digest and cannot return the secret again. */
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { apiPost, queryKeys } from '../data'
import { logger } from '../ui'
import { bridge } from '../bridge'
import { explain, MIN_PASSWORD, readLocalSetupToken } from '../auth/CreateAccount'
import { useDeviceName } from '../setup/deviceName'
import { forgetSetupCode, setupCodeFor } from '../setup/setupLink'
import { Missing } from '../ui/react/components/Missing'
import { WizardFrame } from './Shell'
import './nest.css'


export interface AccountStepProps {
  setupTokenRequired?: boolean
  existingUsername?: string
  nestName: string
  host: React.ReactNode
  /** Caller compatibility preserves this flag without deriving the public nest name from the device. */
  localNest?: boolean
  onCreated: (username: string) => void
}

export function AccountStep({ setupTokenRequired, existingUsername, nestName, host, onCreated }: AccountStepProps): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const deviceName = useDeviceName()
  const [username, setUsername] = useState(existingUsername ?? '')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [code, setCode] = useState('')
  const [localToken, setLocalToken] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ error: unknown } | null>(null)

  useEffect(() => {
    let alive = true
    void readLocalSetupToken().then((token) => {
      if (alive) setLocalToken(token)
    })
    return () => {
      alive = false
    }
  }, [])

  // Setup-link codes survive the nest-selection relaunch and avoid manual re-entry.
  const [linkCode] = useState(() => setupCodeFor(globalThis.window?.desktopAPI?.backendUrl))
  const askForCode = existingUsername === undefined && Boolean(setupTokenRequired) && localToken === null && !linkCode
  const codeToSend = localToken ?? linkCode ?? (setupTokenRequired ? code.trim() : '')
  const tooShort = password.length > 0 && password.length < MIN_PASSWORD
  const mismatch = repeat.length > 0 && repeat !== password
  const ready =
    username.trim().length >= 3 &&
    (existingUsername !== undefined || (password.length >= MIN_PASSWORD &&
    repeat === password &&
    localToken !== undefined &&
    (!setupTokenRequired || codeToSend.length > 0)))

  async function submit() {
    if (!ready || busy) return
    setBusy(true)
    setProblem(null)
    try {
      if (existingUsername !== undefined) {
        await apiPost('/api/me/username', { body: { username: username.trim() } })
        onCreated(username.trim())
        return
      }
      const created = await apiPost('/api/claim', {
        body: {
          label: username.trim(),
          username: username.trim(),
          password,
          ...(codeToSend ? { setupToken: codeToSend } : {}),
          // The server keeps its default public nest name so status and mDNS
          // announcements do not reveal a computer or account name.
        },
      })
      const token = (created as { token?: string } | null)?.token
      if (!token) throw new Error('the server returned no token')
      const stored = await bridge().invoke('auth:set', { token, label: deviceName ?? username.trim(), role: 'owner' })
      if (!stored?.ok) throw new Error('could not store the credential')
      void queryClient.invalidateQueries({ queryKey: queryKeys.server.all })
      forgetSetupCode()
      onCreated(username.trim())
    } catch (error) {
      logger.error('Claim failed', { error: String(error) })
      setProblem({ error })
    } finally {
      setBusy(false)
    }
  }

  const initial = (username.trim()[0] ?? '?').toUpperCase()
  return (
    <WizardFrame
      step="account"
      host={host}
      title={existingUsername !== undefined ? t("Account") : t("Create account")}
      show={
        <div className="kob-account-card" aria-label={t("The account being created")}>
          <div className="kob-account-card__identity">
            <span className="kob-account-card__initial">{initial}</span>
            <span className="kob-account-card__name"><b>{username.trim() || t("account")}</b><span title={t("Can add accounts and change the nest’s music and settings")}>{t('Admin')}</span></span>
          </div>
          <dl>
            <div><dt>{t("Nest")}</dt><dd>{nestName}</dd></div>
            <div><dt>{t("Device")}</dt><dd>{deviceName ?? <Missing kind="nodata" />}</dd></div>
          </dl>
        </div>
      }
      actions={
        <button type="submit" form="kob-account" className="kob-btn kob-btn--coral" disabled={!ready || busy} aria-busy={busy}>
          {existingUsername !== undefined ? t("Next") : t("Create account")}
        </button>
      }
    >
      <form id="kob-account" className="kob-form" onSubmit={event => { event.preventDefault(); void submit() }}>
        <div className="kob-field">
          <label className="kob-label kob-label--tip" htmlFor="kob-user" title={t("You type it to sign in on other computers and in Subsonic apps")}>{t("Username_short")}</label>
          <input className="kob-input" id="kob-user" value={username} autoComplete="username" autoCapitalize="none" spellCheck={false} onChange={event => setUsername(event.target.value)} />
        </div>
        {existingUsername === undefined && <div className="kob-account-passwords">
          <div className="kob-field">
            <label className="kob-label kob-label--tip" htmlFor="kob-pass" title={t("8 characters or more")}>{t("Password")}</label>
            <input className="kob-input" id="kob-pass" type="password" value={password} autoComplete="new-password" aria-invalid={tooShort || undefined} aria-describedby={tooShort ? 'kob-pass-error' : undefined} onChange={event => setPassword(event.target.value)} />
            {tooShort && <span id="kob-pass-error" role="alert">{t("At least {{n}} characters.", { count: MIN_PASSWORD, n: MIN_PASSWORD })}</span>}
          </div>
          <div className="kob-field">
            <label className="kob-label" htmlFor="kob-repeat">{t("Confirm password")}</label>
            <input className="kob-input" id="kob-repeat" type="password" value={repeat} autoComplete="new-password" aria-invalid={mismatch || undefined} aria-describedby={mismatch ? 'kob-repeat-error' : undefined} onChange={event => setRepeat(event.target.value)} />
            {mismatch && <span id="kob-repeat-error" role="alert">{t("The two passwords don't match.")}</span>}
          </div>
        </div>}
        {askForCode && <div className="kob-field">
          <label className="kob-label kob-label--tip" htmlFor="kob-code" title={t("The installer shows it when it finishes")}>{t("Setup code_installation")}</label>
          <input className="kob-input kob-input--mono kob-setup-code" id="kob-code" value={code} autoComplete="off" spellCheck={false} onChange={event => setCode(event.target.value)} />
        </div>}
      {problem ? (
        <div role="alert" className="kob-alert">
          {explain(problem.error, t)}
        </div>
      ) : null}
      </form>
    </WizardFrame>
  )
}
