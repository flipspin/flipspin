import { useEffect, useState } from 'react'
import { useSignInTheme } from '../auth/signInTheme'
import { useTranslation } from 'react-i18next'
import { RotateCw } from 'lucide-react'
import { bridge } from '../bridge'
import type { ServerConnection, ServerStatus } from '../lib/ipc'
import { ChangeNestDialog } from '../onboarding/ChangeNestDialog'
import { openSettings } from '../shell/ServerBadge'
import { ConnectionStatusList } from './StatusList'
import '../ui/tokens/modern.css'
import '../ui/modern-primitives.css'
import './connection.css'

export interface ConnectionDetailsProps {
  connection: ServerConnection
  nestName?: string | null
  address?: string | null
  mode: ServerStatus['mode']
  /** Supply subnet knowledge when available; the shell currently omits it. */
  away?: boolean
  onChangeNest?: () => void
  onRemoteAccess?: () => void
}

/** Mount inside the shared Popover; it owns placement, dismissal and focus. */
export function ConnectionDetails({ connection, nestName, address, mode, away, onChangeNest, onRemoteAccess }: ConnectionDetailsProps) {
  const { t } = useTranslation()
  const theme = useSignInTheme()
  const [now, setNow] = useState(Date.now)
  const [changing, setChanging] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [retryFailed, setRetryFailed] = useState(false)
  // No subnet/lan information in ServerStatus: use the brief's remote fallback.
  const isAway = away ?? (mode === 'external' && connection.checks.some(c => c.id === 'route' && c.status === 'bad'))
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const retry = async () => {
    setRetrying(true)
    setRetryFailed(false)
    try { await bridge().invoke('server:retry-now', undefined) }
    catch { setRetryFailed(true) }
    finally { setRetrying(false) }
  }
  return <section className="krobi-modern ks-surface ks-pop" data-profile="modern" data-theme={theme} aria-label={t("Connection details")}>
    <div className="ks-pop__head">
      <h2>{t("Connection to {{nest}}", { nest: nestName || t("your nest") })}</h2>
      <span className="ks-pop__when" title={t("Flipspin retries automatically.")}>
        {t("checked {{n}} s ago", { n: Math.max(0, Math.floor((now - connection.since) / 1000)) })}
      </span>
    </div>
    {changing && <ChangeNestDialog mode={mode} onClose={() => setChanging(false)} />}
    <ConnectionStatusList connection={connection} address={address} away={isAway} />
    {retryFailed && <p role="alert" className="ks-pop__error">{t("Could not request another attempt. Try again.")}</p>}
    <div className="ks-pop__foot">
      {isAway && <button type="button" className="zm-act ks-pop__remote" onClick={onRemoteAccess ?? (() => openSettings('remoto'))}>{t("Remote access")}</button>}
      <button type="button" className="zm-act ks-pop__change" onClick={onChangeNest ?? (() => setChanging(true))}>{t("Change nest")}</button>
      <button type="button" className="zm-ink" onClick={() => void retry()} disabled={retrying}><RotateCw size={15} strokeWidth={2.5} aria-hidden="true" />{t("Retry")}</button>
    </div>
  </section>
}
