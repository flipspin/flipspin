import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isMusicApp, revokeMyDevice, type MyDevice } from '../settings/gateways'
import { formatAgo, formatSeen } from '../settings/format'

/** Same revocable rows in the pairing result and My account. */
export function MusicAppRows({ devices, onRemoved, heading = true }: { devices: MyDevice[]; onRemoved: (id: string) => void; heading?: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState(false)
  const apps = devices.filter(isMusicApp)
  const remove = async (id: string) => {
    setBusy(id)
    setProblem(false)
    try { await revokeMyDevice(id); onRemoved(id) } catch { setProblem(true) } finally { setBusy(null) }
  }
  return <div className="settings-subsonic-list">
    {heading ? <div className="ks-row"><b>{t("Music apps")}</b><span className="settings-count">{apps.length}</span></div> : null}
    {apps.map(device => <div className="ks-row" key={device.id}>
      <span><b>{device.label}</b>{device.credentialType ? <> · <span className="settings-muted">{device.credentialType === 'api-key' ? t("API key") : t("App password")}</span></> : null}
        {device.subsonicClientName ? <> · <span className="settings-muted" title={t("Name sent by the app")}>{device.subsonicClientName}</span></> : null}</span>
      <span className="ks-c"><span className="settings-muted">{device.lastSubsonicRequestAt ? Date.now() - Date.parse(device.lastSubsonicRequestAt) < 86_400_000 ? formatAgo(Date.parse(device.lastSubsonicRequestAt)) : formatSeen(device.lastSubsonicRequestAt) : t("unused")}</span>
      {!device.isCurrent ? <button className="ks-link" disabled={busy !== null} type="button" onClick={() => void remove(device.id)} aria-label={t("Remove {{name}}", { name: device.label })}>{t("Remove")}</button> : null}</span>
    </div>)}
    {problem ? <span className="z-err" role="alert">{t("Could not remove it · it stays signed in")}</span> : null}
  </div>
}
