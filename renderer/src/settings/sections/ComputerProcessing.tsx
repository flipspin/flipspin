/** Native preferences live in General; the shared engine lives in Addons. */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { configureMacWorker } from '../../lyrics/macEngine'
import { bridge } from '../../bridge'
import type { LoginItemState } from '../../lib/ipc'
import { Switch, Tipped, useToast } from '../parts'
import { useComputerProcessing } from './useComputerProcessing'

function LoginItem(): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const [state, setState] = useState<LoginItemState | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    const read = () => { void bridge().invoke('system:login-item-get', undefined).then(s => { if (alive) { setState(s); setFailed(false) } }, () => { if (alive) setFailed(true) }) }
    read()
    window.addEventListener('focus', read)
    return () => { alive = false; window.removeEventListener('focus', read) }
  }, [])
  const flip = async (enabled: boolean) => {
    setBusy(true)
    try {
      const reported = await bridge().invoke('system:login-item-set', { enabled })
      setState(reported)
      setFailed(false)
      if (reported.error) toast(t("Could not change “Open at login”"), { err: true })
    } catch { setFailed(true); toast(t("Could not change “Open at login”"), { err: true }) }
    finally { setBusy(false) }
  }
  const reason = failed || state?.error ? t("Could not check login items") : state?.status === 'requires-approval' ? t("Approve it in System Settings") : state && !state.supported ? t("Not available on this system") : null
  return <div className="ks-row">
    <dt><Tipped tip={[t("Flipspin opens when you sign in on this computer and processes while it is open."), reason].filter(Boolean).join(' · ')}>{t("Open at login")}</Tipped></dt>
    <dd className="settings-process__control"><Switch label={t("Open at login")} checked={state?.enabled === true} disabled={busy || !state?.supported || failed} title={reason ?? undefined} onChange={enabled => void flip(enabled)} /></dd>
  </div>
}

export function ComputerPreferences(): React.JSX.Element | null {
  const { t } = useTranslation()
  const computer = useComputerProcessing()
  if (!computer) return null
  const { status, isMac, cannot, busy, act } = computer
  if (!isMac && cannot) return null
  return <section className="settings-block ks-group" aria-label={t("Flipspin on this computer")}>
    <div className="settings-block__head"><h3>{t("Flipspin on this computer")}</h3></div>
    {isMac ? <div className="ks-row"><div className="ks-l"><b>{t("Menu bar")}</b><span>{t("icon")}</span></div><div className="ks-c"><Switch label={t("Menu bar")} checked={status.tray} disabled={busy} onChange={next => void act(() => configureMacWorker(next))} /></div></div> : null}
    {!cannot ? <LoginItem /> : null}
  </section>
}
