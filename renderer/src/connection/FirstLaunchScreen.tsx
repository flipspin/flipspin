import { useEffect, useState } from 'react'
import { useSignInTheme } from '../auth/signInTheme'
import { useTranslation } from 'react-i18next'
import type { ServerConnection } from '../lib/ipc'
import logo from '../../../resources/icon/krobi-figure.svg'
import { APP_NAME } from '../brand'
import { ConnectionStatusList } from './StatusList'
import '../ui/tokens/modern.css'
import '../ui/modern-primitives.css'
import './connection.css'

export interface FirstLaunchScreenProps {
  connection: ServerConnection
  nestName?: string | null
  address?: string | null
  /** One clock for the network, handshake and session waits in this window. */
  startedAt: number
  onChangeNest: () => void
  onUseOffline: () => void
}

export function FirstLaunchScreen({ connection, nestName, address, startedAt, onChangeNest, onUseOffline }: FirstLaunchScreenProps) {
  const { t } = useTranslation()
  const theme = useSignInTheme()
  const [slow, setSlow] = useState(() => Date.now() - startedAt >= 10_000)
  useEffect(() => {
    setSlow(Date.now() - startedAt >= 10_000)
    const timer = setTimeout(() => setSlow(true), Math.max(0, startedAt + 10_000 - Date.now()))
    return () => clearTimeout(timer)
  }, [startedAt])
  return <main className="krobi-modern ks-surface ks-wait" data-profile="modern" data-theme={theme} aria-labelledby="connection-heading">
    <div className="ks-wait__col">
      <div className="ks-wait__logo"><img src={logo} alt="" />{APP_NAME}</div>
      <div className="ks-wait__heading" role="status">
        <h1 id="connection-heading" className="ks-wait__title">{t("Connecting to {{nest}}…", { nest: nestName || t("your nest") })}</h1>
        {slow && <p className="ks-wait__line">{t("This is taking longer than usual.")}</p>}
      </div>
      <ConnectionStatusList connection={connection} address={address} />
      <div className="ks-wait__actions">
        <button type="button" className="zm-act" onClick={onChangeNest}>{t("Change nest")}</button>
        <button type="button" className="zm-ink" onClick={onUseOffline} title={t("Open Flipspin with what is on this computer")}>{t("Use offline")}</button>
      </div>
    </div>
  </main>
}
