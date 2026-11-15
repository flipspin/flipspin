/** App passwords are minted only on request, so "Skip" creates no unused device.
 * Leaving revokes an unused password unless "Next" retains it. */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { apiDelete, apiGet, apiPost } from '../data'
import { logger } from '../ui'
import { Button } from '../ui/react/components/Button'
import { CopyButton } from './CopyButton'
import { WizardFrame } from './Shell'
import './steps.css'
import { Missing } from '../ui/react/components/Missing'

type Minted = { deviceId: string; token: string }

export interface DevicesStepProps {
  /** Subsonic clients receive the nest address reachable from their network. */
  serverUrl: string
  username: string
  finishing?: boolean
  finishError?: string | null
  initialCount?: number
  host: React.ReactNode
  onBack?: () => void
  onDone: (paired: number) => void
}

export function DevicesStep({ serverUrl, username, initialCount = 0, finishing = false, finishError, host, onBack, onDone }: DevicesStepProps): React.JSX.Element {
  const { t } = useTranslation()
  const [appPassword, setAppPassword] = useState<Minted | null>(null)
  const [busy, setBusy] = useState(false)
  const unusedPassword = useRef<Minted | null>(null)
  useEffect(() => () => {
    const unused = unusedPassword.current
    if (unused) {
      void apiGet('/api/me/devices')
        .then(({ devices }) => {
          if (!devices.find(device => device.id === unused.deviceId)?.lastSeenAt) {
            return apiDelete('/api/me/devices/{device_id}', { params: { path: { device_id: unused.deviceId } } })
          }
        })
        .catch(error => logger.debug('Unused pairing cleanup failed', { error: String(error) }))
    }
  }, [])
  const [problem, setProblem] = useState<string | null>(null)

  async function mint() {
    setBusy(true)
    setProblem(null)
    try {
      const made = await apiPost('/api/me/devices/app-password', { body: { label: t("Subsonic client") } })
      unusedPassword.current = { deviceId: made.device.id, token: made.token }
      setAppPassword(unusedPassword.current)
    } catch (error) {
      logger.warn('Could not create a device', { error: String(error) })
      setProblem(t("The access couldn't be created."))
    } finally {
      setBusy(false)
    }
  }

  const count = initialCount + (appPassword ? 1 : 0)

  return (
    <WizardFrame
      step="devices"
      host={host}
      title={t("Listen on your phone")}
      show={<div className="kob-device-phone"><b>{t("Add server")}</b><code>{serverUrl.replace(/^https?:\/\//, '')}</code><code>{username}</code><code>••••••••</code><i aria-hidden="true" /></div>}
      back={onBack ?
        <Button className="kob-btn kob-btn--ghost" variant="ghost" disabled={busy || finishing} onClick={onBack}>
          {t("Back")}
        </Button> : undefined
      }
      actions={
        <>
          <Button className="kob-btn kob-btn--ghost" variant="ghost" aria-label={t("Skip")} disabled={busy || finishing} onClick={() => onDone(initialCount)} title={t("Also in Settings → My devices")}>
            {t("Skip")}
          </Button>
          <Button className="kob-btn kob-btn--coral" variant="primary" disabled={busy || finishing} onClick={() => { unusedPassword.current = null; onDone(count) }}>
            {t("Next")}
          </Button>
        </>
      }
    >
      {finishError && <p className="z-err" role="alert">{finishError}</p>}
      <div className="kob-form">
        <dl className="kob-rows kob-credentials" aria-label={t("Subsonic credentials")}>
          <div className="kob-row">
            <dt>
              <span className="kob-tip" title={t("Paste this into the app as the server address")}>
                {t("Server")}
              </span>
            </dt>
            <dd>{serverUrl}</dd>
            <CopyButton look="wizard" text={serverUrl} />
          </div>
          <div className="kob-row">
            <dt>{t("Username_short")}</dt>
            <dd>{username}</dd>
            <CopyButton look="wizard" text={username} />
          </div>
          <div className="kob-row">
            <dt>
              <span
                className="kob-tip"
                title={t("A password just for Subsonic apps; you can revoke it in Settings → My devices")}
              >
                {t("App password")}
              </span>
            </dt>
            <dd>{appPassword ? appPassword.token : <Missing kind="notSet" />}</dd>
            {appPassword ? (
              <CopyButton look="wizard" text={appPassword.token} />
            ) : (
              <Button className="kob-btn kob-btn--sm kob-btn--coral" size="sm" loading={busy} onClick={() => void mint()}>
                {t("Generate")}
              </Button>
            )}
          </div>
        </dl>

        <span className="kob-k kob-tip" title={t("Third-party apps that speak OpenSubsonic; they work with Flipspin today")}>{t("COMPATIBLE APPS")}</span>
        <div className="kob-compatible-apps">{[['Symfonium', 'Android'], ['Tempo', 'Android'], ['Amperfy', 'iPhone'], ['substreamer', t("Multiple")], ['play:Sub', 'iPhone']].map(([app, os]) => <div key={app}><b>{app}</b><span className="kob-mono kob-muted">{os}</span></div>)}</div>
        <span className="kob-status kob-muted" title={t("Flipspin’s iPhone and Android apps come after this release")}><span className="kob-dot is-off" aria-hidden="true" />{t("Flipspin app · Coming soon")}</span>
        {problem ? (
          <div role="alert" className="kob-alert">
            {problem}
          </div>
        ) : null}
      </div>
    </WizardFrame>
  )
}
