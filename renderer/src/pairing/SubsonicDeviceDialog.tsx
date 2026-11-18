import { poll as pollInterval, startPoll } from '../data/poll'
import { msg } from '../i18n';
/** App-first pairing; the secret exists only in the one-shot reveal. */
import { useEffect, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

import { addAppPassword, addSubsonicApiKey, listMyDevices, type MyDevice } from '../settings/gateways'
import { isApiError } from '../data'
import { CopyButton, Dot, Modal, Word } from '../settings/parts'
import { formatAgo } from '../settings/format'
import { Missing } from '../ui/react/components/Missing'
import { MusicAppRows } from './MusicAppRows'

type Mechanism = 'app-password' | 'api-key'
const musicApps = [
  { name: 'Symfonium', platform: 'Android', mechanism: 'api-key', color: 'coral', entry: msg("Enter these in Symfonium → Add provider → OpenSubsonic") },
  { name: 'Amperfy', platform: 'iPhone', mechanism: 'app-password', color: 'blue', entry: msg("Enter these in Amperfy → URL, username and password") },
  { name: 'substreamer', platform: msg("Multiple"), mechanism: 'app-password', color: 'green', entry: msg("Enter these in substreamer → Server URL, Username and Password") },
  { name: 'Feishin', platform: msg("Desktop"), mechanism: 'app-password', color: 'purple', entry: msg("Enter these in Feishin → URL, username and password") },
  { name: 'Supersonic', platform: msg("Desktop"), mechanism: 'app-password', color: 'teal', entry: msg("Enter these in Supersonic → Hostname, username and password") },
  { name: 'Tempus', platform: 'Android', mechanism: 'app-password', color: 'green', entry: msg("Enter these in Tempus → Public URL, User name and Password") },
  { name: 'Crossonic', platform: msg("Multiple"), mechanism: 'api-key', color: 'yellow', entry: msg("Enter these in Crossonic → URL → API key") },
  { name: 'Nautiline', platform: 'iPhone', mechanism: 'api-key', color: 'rose', entry: msg("Enter these in Nautiline → URL and API key") },
  { name: 'Otra app', platform: 'Subsonic', mechanism: 'app-password', color: 'blue', entry: msg("Enter these in your app → Server, username and password") },
] as const

export function SubsonicDeviceDialog({ serverUrl, username, onClose, onAdded }: {
  serverUrl: string
  username: string | null | undefined
  onClose: () => void
  onAdded: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [appIndex, setAppIndex] = useState(0)
  const app = musicApps[appIndex]!
  const [mechanism, setMechanism] = useState<Mechanism>(app.mechanism)
  const [override, setOverride] = useState(false)
  const [label, setLabel] = useState<string>(app.name)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [devices, setDevices] = useState<MyDevice[]>([])
  const [step, setStep] = useState<'choose' | 'reveal' | 'status'>('choose')
  const apiKey = mechanism === 'api-key'
  const device = devices.find(row => row.id === deviceId)
  const connected = Boolean(device?.firstSubsonicRequestAt)
  const close = () => {
    if (connected) onAdded() // refresh My account with the observed connection
    onClose()
  }
  // Keep the nest's scheme, port and deployment path; clients append /rest.
  const address = serverUrl.replace(/\/rest\/?$/, '').replace(/\/$/, '')

  useEffect(() => {
    if (!deviceId) return
    const controller = new AbortController()
    const poll = async () => {
      try {
        const rows = await listMyDevices(controller.signal)
        if (!controller.signal.aborted) {
          setDevices(rows)
          setProblem(null)
        }
      } catch {
        if (!controller.signal.aborted) setProblem(t("Could not check the app’s connection"))
      }
    }
    const stop = startPoll(() => pollInterval('waiting', true), poll)
    return () => { controller.abort(); stop() }
  }, [deviceId, t])

  const choose = (index: number) => {
    const next = musicApps[index]!
    setAppIndex(index)
    setMechanism(next.mechanism)
    setLabel(next.name === 'Otra app' ? '' : next.name)
    setOverride(false)
  }

  const mint = async () => {
    setBusy(true)
    setProblem(null)
    try {
      const minted = await (apiKey ? addSubsonicApiKey : addAppPassword)(label.trim())
      setSecret(minted.token)
      setDeviceId(minted.device.id)
      setDevices([minted.device])
      setStep('reveal')
      onAdded()
    } catch (error) {
      setProblem(isApiError(error) && error.status === 422
        ? t("That name is not valid")
        : apiKey ? t("Could not create the API key") : t("Could not create the password"))
    } finally {
      setBusy(false)
    }
  }

  const typeName = apiKey ? t("API key") : t("App password")
  const typeTip = apiKey
    ? t("This app accepts OpenSubsonic API keys; the nest stores only a fingerprint.")
    : t("Subsonic: username and app password, using password or salted token authentication (MD5).")
  const appName = app.name === 'Otra app' ? t("Other app") : app.name
  const failureTip = t("The app sent a key together with token authentication. Enable its API key field or create an app password.")

  return (
    <Modal title={step === 'choose' ? t("Add a music app") : label.trim()} onClose={busy ? () => {} : close}>
      {step === 'choose' ? (
        <form className="settings-qr__side" onSubmit={event => { event.preventDefault(); if (label.trim() && !busy) void mint() }}>
          <span className="settings-muted">{t("Apps that speak Subsonic")}</span>
          <div className="settings-presets settings-subsonic-apps" role="radiogroup" aria-label={t("Your app")} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || busy) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? musicApps.length - 1
              : (appIndex + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + musicApps.length) % musicApps.length
            choose(next)
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus()
          }}>
            {musicApps.map((item, index) => <button key={item.name} className="settings-preset" type="button" role="radio"
              aria-label={item.name === 'Otra app' ? t("Other app") : item.name} aria-checked={index === appIndex}
              tabIndex={index === appIndex ? 0 : -1} disabled={busy} onClick={() => choose(index)}>
              <i className="settings-subsonic-icon" style={{ '--app-color': `var(--accent-${item.color})` } as CSSProperties} aria-hidden />
              <b>{item.name === 'Otra app' ? t("Other app") : item.name}</b><span className="settings-preset__n">{t(item.platform)}</span>
            </button>)}
          </div>
          <div className="ks-row"><span>{t("Sign in with")}</span><span title={typeTip}>{typeName}</span></div>
          <label className="z-field"><span className="z-label">{t("App name")}</span>
            <input className="ks-field" value={label} maxLength={80} disabled={busy} onChange={event => setLabel(event.target.value)} />
          </label>
          {override ? <div className="settings-presets settings-subsonic-choices" role="radiogroup" aria-label={t("Access type")} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || busy) return
            event.preventDefault()
            const next = event.key === 'Home' ? 'app-password' : event.key === 'End' ? 'api-key' : apiKey ? 'app-password' : 'api-key'
            setMechanism(next)
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next === 'api-key' ? 1 : 0]?.focus()
          }}>
            {(['app-password', 'api-key'] as const).map(kind => <button type="button" role="radio" className="settings-preset" key={kind}
              aria-checked={mechanism === kind} tabIndex={mechanism === kind ? 0 : -1} disabled={busy} title={kind === 'api-key' ? t("OpenSubsonic: apiKey, without a username or password.") : t("Subsonic: username and app password, using password or salted token authentication (MD5).")}
              onClick={() => setMechanism(kind)}>{kind === 'api-key' ? t("API key") : t("App password")}</button>)}
          </div> : null}
          <div className="settings-modal__do">
            <button className="ks-link" type="button" disabled={busy} onClick={() => setOverride(!override)}>{t("Choose the type")}</button>
            <button className="ks-btn" type="button" onClick={onClose} disabled={busy}>{t("Cancel")}</button>
            <button className="ks-btn ks-btn--go" type="submit" disabled={!label.trim() || busy}>{t("Create")}</button>
          </div>
        </form>
      ) : step === 'reveal' && secret ? (
        <>
          <span className="settings-muted">{t(app.entry)}</span>
          <dl className="settings-kv settings-kv--copy">
            <div><dt title={t("Full address, including http:// and the port; without /rest")}>{t("Server")}</dt><dd className="z-mono"><span>{address}</span><CopyButton value={address} /></dd></div>
            {!apiKey ? <div><dt>{t("Username_short")}</dt><dd className="z-mono">{username ? <><span>{username}</span><CopyButton value={username} /></> : <Missing kind="unavailable" reason={t("The nest’s operating system could not report this detail.")} />}</dd></div> : null}
            <div><dt title={apiKey && app.name === 'Symfonium' ? t("In Symfonium, enable “Use an API key” and enter it in “API key”") : typeTip}>{apiKey ? t("API key") : t("Password")}</dt>
              <dd className="z-mono"><span className="settings-subsonic-secret">{secret}</span><CopyButton value={secret} label={apiKey ? t("Copy API key") : t("Copy password")} /></dd></div>
          </dl>
          <div className="ks-row"><Word tone="warn">{t("It won’t be shown again")}</Word><span className="settings-muted">{t("already saved in the nest")}</span></div>
          <div className="settings-modal__do"><button className="ks-btn ks-btn--go" type="button" onClick={() => { setSecret(null); setStep('status') }}>{t("Done")}</button></div>
        </>
      ) : (
        <>
          <div className="ks-row" role="status"><Dot tone={connected ? 'ok' : 'warn'} /><span>{connected ? t("Connected") : t("Waiting for {{app}}", { app: appName === t("Other app") ? label.trim() : appName })}</span>
            <span className="settings-muted">{connected ? formatAgo(Date.parse(device?.lastSubsonicRequestAt ?? device?.firstSubsonicRequestAt ?? '')) : device?.createdAt ? t("created {{ago}}", { ago: formatAgo(Date.parse(device.createdAt)) }) : null}</span></div>
          {!connected && device?.lastSubsonicFailure === 'wrong-mechanism' ? <div className="ks-row" role="status"><Dot tone="bad" /><span title={failureTip}>{t("{{app}} tried to sign in without the key", { app: appName })}</span><span className="settings-muted">{device.lastSubsonicFailureAt ? formatAgo(Date.parse(device.lastSubsonicFailureAt)) : null}</span></div> : null}
          {connected ? <MusicAppRows devices={devices} onRemoved={id => { setDevices(rows => rows.filter(row => row.id !== id)); onAdded() }} /> : null}
          <div className="settings-modal__do"><button className="ks-btn" type="button" onClick={close}>{connected ? t("Done") : t("Close")}</button></div>
        </>
      )}
      {problem ? <span className="z-err" role="alert">{problem}</span> : null}
    </Modal>
  )
}
