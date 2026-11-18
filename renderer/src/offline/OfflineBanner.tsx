import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { bridge, hasBridge } from '../bridge'
import { useConnectionStatus } from '../connection/connection'
import { useOffline } from './useOffline'
import { useForcedOffline } from './mode'
import './offline.css'

export function OfflineBanner({ details }: { details?: ReactNode }) {
  const { t, i18n } = useTranslation()
  const offline = useOffline()
  const forced = useForcedOffline()
  const status = useConnectionStatus()
  const name = status.kind === 'ready' ? status.value?.name : null
  const [at, setAt] = useState<number | null>(null)
  useEffect(() => {
    if (!offline || !hasBridge()) return
    let alive = true
    const refresh = () => { void bridge().invoke('offline:snapshot', { kind: 'listing' }).then(row => { if (alive) setAt(row?.fetchedAt ?? null) }).catch(() => { if (alive) setAt(null) }) }
    const stop = bridge().on('offline:changed', refresh)
    refresh()
    return () => { alive = false; stop() }
  }, [offline])
  if (!offline) return null
  const time = at === null ? null : new Date(at * 1000).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit', hour12: false })
  return <div className="ak-banner" role="status">
    <span className="ak-banner__dot" aria-hidden="true" />
    <b title={t("Downloaded music plays; changes will be sent when the nest returns")}>{forced ? t("Offline mode") : t("Disconnected from {{server}}", { server: name || t("your nest") })}</b>
    {time ? <span className="ak-banner__age" title={t("A copy of your library saved on this computer")}>{t("copy from {{time}}", { time })}</span> : null}
    <span className="ak-banner__details">{!forced ? details : null}</span>
  </div>
}
