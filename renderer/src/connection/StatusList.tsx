import { Fragment } from 'react'
import { useSignInTheme } from '../auth/signInTheme'
import { useTranslation } from 'react-i18next'
import type { ServerConnection } from '../lib/ipc'
import { Missing } from '../ui/react/components/Missing'
import '../ui/tokens/modern.css'
import '../ui/modern-primitives.css'
import './connection.css'

export interface ConnectionStatusListProps {
  connection: ServerConnection
  /** Address in use (via ?? baseUrl), for shells whose check details are null. */
  address?: string | null
  away?: boolean
}

/** The shell decides the checks; this list only supplies their words. */
export function ConnectionStatusList({ connection, address, away = false }: ConnectionStatusListProps) {
  const { t } = useTranslation()
  const theme = useSignInTheme()
  let host: string | undefined
  let port: string | undefined
  try {
    const url = new URL(address)
    host = url.hostname
    port = url.port || (url.protocol === 'https:' ? '443' : '80')
  } catch { /* No address yet: an optional detail stays absent. */ }

  return <dl className="krobi-modern ks-surface ks-status" data-profile="modern" data-theme={theme}>
    {connection.checks.map(check => {
      let label: string
      let word: string
      let reason: string
      let missing: 'connecting' | 'unverified' | undefined
      if (check.id === 'this-computer') {
        label = t("Network")
        word = check.status === 'ok' ? t("Connected") : t("No network")
        reason = check.status === 'ok'
          ? away ? t("You are on another network, away from home.") : t("This computer is connected to the network.")
          : t("This computer has no access to the local network.")
      } else if (check.id === 'route') {
        label = t("Nest computer")
        if (check.status === 'ok') {
          word = t("Online")
          reason = t("The nest computer is on and connected to the network.")
        } else if (check.status === 'idle' && connection.lastError !== 'connection-lost') {
          missing = 'connecting'
          reason = t("Flipspin is looking for the nest computer.")
        } else {
          word = t("No answer")
          reason = away ? t("Away from home, reach the nest with Tailscale, your router’s VPN, or a domain.")
            : connection.state === 'connecting'
              ? t("When opening Flipspin or waking from sleep, the system may take a while to allow local network access. Flipspin retries automatically.")
              : t("Flipspin retries automatically.")
        }
      } else {
        label = t('Flipspin')
        if (check.status === 'ok') {
          word = t("Running")
          reason = t("Flipspin responds on the nest computer.")
        } else if (check.status === 'bad' && connection.lastError === 'refused-port') {
          word = t("Stopped")
          reason = t("The computer responds, but Flipspin is not running on it. It may be restarting.")
        } else if (check.status === 'bad') {
          word = t("No answer")
          reason = t("The response on this port could not be verified as Flipspin.")
        } else {
          missing = 'unverified'
          reason = t("Checked when the nest computer responds.")
        }
      }
      const detail = check.detail ?? (check.id === 'route' ? host : check.id === 'krobi' && port ? t("port {{port}}", { port }) : undefined)
      return <Fragment key={check.id}>
        <dt>{label}</dt>
        <dd className="ks-status__state" title={reason}>
          <span className="ks-dot" data-status={check.status} aria-hidden="true" />
          {missing ? <Missing kind={missing} reason={reason} /> : <span>{word}<span className="k-sr-only">: {reason}</span></span>}
        </dd>
        <dd className="ks-status__detail" title={detail}>{detail}</dd>
      </Fragment>
    })}
  </dl>
}
