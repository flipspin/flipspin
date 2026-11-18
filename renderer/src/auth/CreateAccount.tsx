/** The first account becomes the owner, and the server closes setup after claim.
 * Ask for a setup token only when the handshake requires it. */
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'

import { apiPost, isApiError, queryKeys, serverDetail } from '../data'
import { logger } from '../ui'
import { bridge, hasBridge } from '../bridge'
import { useDeviceName } from '../setup/deviceName'
import { SetupSurface } from '../setup/SetupSurface'
import { Button } from '../ui/react/components/Button'
import { Field } from '../ui/react/components/Field'
import { Input } from '../ui/react/components/Input'

/** The shell reads the local server's protected setup token so its operator can claim it.
 * Remote setup still requires the token supplied by that server's operator. */
export async function readLocalSetupToken(): Promise<string | null> {
  if (!hasBridge()) return null
  try {
    const status = await bridge().invoke('server:get-status', undefined)
    if (status?.mode !== 'child') return null
    const answer = await bridge().invoke('server:local-setup-token', undefined)
    const token = typeof answer?.token === 'string' ? answer.token.trim() : ''
    return token === '' ? null : token
  } catch {
    return null
  }
}

/** The server's floor. Stated up front rather than after a rejected submit. */
export const MIN_PASSWORD = 8

export interface CreateAccountProps {
  /** From the handshake. When true, this server wants its setup token. */
  setupTokenRequired?: boolean
  /** Where the server keeps its data; shown once, while it is still empty. */
  dataDir?: string
  /** Called after the account exists and this install holds its credential. */
  onCreated: () => void
}

export function CreateAccount({ setupTokenRequired, dataDir, onCreated }: CreateAccountProps) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const deviceName = useDeviceName()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [setupToken, setSetupToken] = useState('')
  // `undefined` while the shell is being asked; then the token or null.
  const [localToken, setLocalToken] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // The failure itself, worded at render so the sentence follows the language.
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

  const asking = localToken === undefined
  // Shown only when the server wants a code *and* the shell had none to give.
  const askForCode = Boolean(setupTokenRequired) && !asking && localToken === null
  const codeToSend = localToken ?? (setupTokenRequired ? setupToken.trim() : '')

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD
  const mismatch = repeat.length > 0 && repeat !== password
  const ready =
    username.trim().length >= 3 &&
    password.length >= MIN_PASSWORD &&
    repeat === password &&
    !(setupTokenRequired && asking) &&
    (!setupTokenRequired || codeToSend.length > 0)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const created = await apiPost('/api/claim', {
        body: {
          label: username.trim(),
          username: username.trim(),
          password,
          ...(codeToSend ? { setupToken: codeToSend } : {}),
          // No nestName: the server's default is «Nido». The name is public
          // (/api/status, mDNS), so it never carries a computer or account name.
        },
      })
      const token = (created as { token?: string } | null)?.token
      if (!token) throw new Error('the server returned no token')

      // Persist the token immediately because the server keeps only its digest.
      const stored = await bridge().invoke('auth:set', {
        token,
        label: deviceName ?? username.trim(),
        role: 'owner',
      })
      if (!stored?.ok) throw new Error('could not store the credential')
      // Invalidate the handshake so a claimed server cannot keep offering setup.
      void queryClient.invalidateQueries({ queryKey: queryKeys.server.all })
      onCreated()
    } catch (error) {
      logger.error('Claim failed', { error: String(error) })
      setProblem({ error })
    } finally {
      setBusy(false)
    }
  }

  return (
    <SetupSurface labelledBy="create-account-heading">
      <h1 id="create-account-heading" className="krobi-setup__title">
        {t("Create your account")}
      </h1>
      <p className="z-say">
        {dataDir
          ? t("This nest is new and will keep its data in {{dataDir}}.", {
              dataDir,
            })
          : t("This nest is new.")}
      </p>

      <form className="krobi-setup__form" onSubmit={submit}>
        <Field label={t("Username_short")} htmlFor="create-username">
          <Input
            id="create-username"
            type="text"
            value={username}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>

        {}
        <Field
          label={t("Password")}
          htmlFor="create-password"
          helper={
            tooShort
              ? t("At least {{n}} characters.", { count: MIN_PASSWORD, n: MIN_PASSWORD })
              : t("At least {{n}} characters. No need to mix in symbols.", {
                  count: MIN_PASSWORD,
                  n: MIN_PASSWORD,
                })
          }
        >
          <Input
            id="create-password"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <Field
          label={t("Repeat the password")}
          htmlFor="create-repeat"
          error={mismatch ? t("The two passwords don't match.") : undefined}
        >
          <Input
            id="create-repeat"
            type="password"
            value={repeat}
            autoComplete="new-password"
            onChange={(e) => setRepeat(e.target.value)}
          />
        </Field>

        {askForCode && (
          <Field
            label={t("Setup code_installation")}
            htmlFor="create-setup-token"
            helper={t(
              "This nest asks for the code it printed when it started. It's in its log and in its data folder.",
            )}
          >
            <Input
              id="create-setup-token"
              type="password"
              value={setupToken}
              onChange={(e) => setSetupToken(e.target.value)}
            />
          </Field>
        )}

        <div className="krobi-setup__actions">
          <Button type="submit" variant="primary" disabled={!ready || busy}>
            {busy ? t("Creating…") : t("Create the account")}
          </Button>
        </div>
      </form>

      {problem && (
        <div role="alert" className="z-banner" data-tone="danger">
          {explain(problem.error, t)}
        </div>
      )}
    </SetupSurface>
  )
}

/** A claim conflict means another client claimed the server after the handshake; retrying cannot reclaim it. */
export function explain(error: unknown, t: TFunction): string {
  if (isApiError(error)) {
    if (error.status === 409) {
      return t("This nest already has an account. Sign in with it.")
    }
    if (error.status === 401) return t("That setup code isn't the right one.")
    if (error.status === 429) return t("Too many attempts. Wait a minute and try again.")
    if (error.status === 422) return serverDetail(error) ?? t("Check the username and password.")
  }
  return t("The account couldn't be created.")
}
