/** Nest choices use the shell's handshakes; `server:use` persists and relaunches. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DiscoveredNest, ServerMode } from '../lib/ipc'
import { bridge } from '../bridge'
import { APP_NAME, INSTALL_SCRIPT_URL, SERVER_IMAGE } from '../brand'
import { PROBE_FAILURE, PROBE_FAILURE_UNKNOWN } from '../settings/messages'
import { useDeviceName } from '../setup/deviceName'
import { parseSetupLink, rememberSetupCode, type SetupLinkError } from '../setup/setupLink'
import { msg } from '../i18n'
import { Missing } from '../ui/react/components/Missing'
import { Icon, WizardFrame } from './Shell'
import { CustomHeaders } from '../settings/sections/CustomHeaders'
import { CopyButton } from './CopyButton'
import './nest.css'

export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_SCRIPT_URL} | sh`
const DOCKER_COMMAND = `docker run -d --name krobi --restart unless-stopped \\
  -p 8000:8000 -v krobi-data:/data -v /ruta/a/tu/musica:/music \\
  ${SERVER_IMAGE}`
const hostOf = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/+$/, '')

/** Setup-link explanations use the parse-error codes in contracts/setup-link.json. */
const LINK_FAILURE: Record<SetupLinkError, string> = {
  'empty': msg("Paste the link the installer printed."),
  'not-a-link': msg("Paste the whole link the installer printed; it starts with krobi://"),
  'not-setup': msg("This isn’t a {{app}} setup link."),
  'bad-host': msg("This isn’t a {{app}} setup link."),
  'no-code': msg("This link is missing its code. Copy all of it."),
  'bad-code': msg("This link’s code isn’t valid. Copy all of it."),
}

export interface NestStepProps {
  mode: ServerMode | null
  onBack?: () => void
  /** Joining an existing nest gives the address field initial focus. */
  join?: boolean
}

export function NestStep({ mode, onBack, join = false }: NestStepProps): React.JSX.Element {
  const { t } = useTranslation()
  const device = useDeviceName()
  const [nests, setNests] = useState<DiscoveredNest[] | null>(null)
  const [probed, setProbed] = useState<DiscoveredNest[]>([])
  const [address, setAddress] = useState('')
  const [link, setLink] = useState('')
  const [byAddress, setByAddress] = useState(false)
  const [installOpen, setInstallOpen] = useState(false)
  const [checking, setChecking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const committing = useRef(false)

  // Discovery announces only claimed nests; unclaimed nests require "Test".
  useEffect(() => {
    let alive = true
    void bridge().invoke('server:discover', undefined)
      .then(answer => Array.isArray(answer?.nests) ? answer.nests : [], () => [] as DiscoveredNest[])
      .then(found => { if (alive) setNests(found) })
    return () => { alive = false }
  }, [])

  const probe = useCallback(async () => {
    if (!address.trim() || checking) return
    setChecking(true)
    setProblem(null)
    try {
      const result = await bridge().invoke('server:probe', { address: address.trim() })
      if (result.ok === true) {
        const { handshake } = result
        setProbed(found => [...found.filter(nest => nest.url !== result.url), {
          url: result.url, name: handshake.name ?? t("Nest"),
          instanceId: handshake.instanceId, version: handshake.version,
        }])
      } else setProblem(PROBE_FAILURE[result.reason] || PROBE_FAILURE_UNKNOWN)
    } catch {
      setProblem(msg("The app couldn't check the address. Restart it."))
    } finally { setChecking(false) }
  }, [address, checking, t])

  const commit = useCallback(async (target: string | null) => {
    if (committing.current) return
    committing.current = true
    setBusy(true)
    setProblem(null)
    try {
      if (target === null && mode === 'child') {
        window.location.reload()
        return
      }
      const result = await bridge().invoke('server:use', { address: target })
      if (!result.ok) setProblem(msg("Couldn't use that nest."))
      // Environment-locked choices remain unchanged; the shell owns relaunching.
    } catch {
      setProblem(msg("The app couldn't apply the change. Restart it."))
    } finally {
      committing.current = false
      setBusy(false)
    }
  }, [mode])

  // Setup links contain claim secrets and stay out of logs and error messages.
  const connectLink = useCallback(async () => {
    const parsed = parseSetupLink(link)
    if (parsed.ok === false) {
      setProblem(LINK_FAILURE[parsed.error])
      return
    }
    rememberSetupCode(parsed.address, parsed.code)
    await commit(parsed.address)
  }, [link, commit])

  let headerOrigin: string | undefined
  try {
    const parsedLink = !byAddress ? parseSetupLink(link) : null
    const raw = byAddress ? address : parsedLink?.ok ? parsedLink.address : ''
    const url = new URL(raw)
    if (/^https?:$/.test(url.protocol) && !url.username && !url.password) headerOrigin = `${url.origin}${url.pathname.replace(/\/+$/, '')}`
  } catch { /* Headers need an explicit http(s) address. */ }

  const seen = new Set<string>()
  const rows = [...probed, ...(nests ?? [])].filter(nest => {
    const key = nest.instanceId || hostOf(nest.url)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return <WizardFrame step="nest" title={t("Choose your nest")}
    back={onBack && <button type="button" className="kob-btn kob-btn--ghost" onClick={onBack}>{t("Back")}</button>}
    actions={null}
    show={<div className="kob-nest-figure" role="img" aria-label={t("This computer connects to the nest")}>
      <div className="kob-nest-figure__device"><i className="kob-nest-figure__mac" /><b>{t("This computer")}</b><span className="kob-mono kob-muted">{device ?? <Missing kind="nodata" />}</span></div>
      <i className="kob-nest-figure__link" aria-hidden="true" />
      <div className="kob-nest-figure__device"><i className="kob-nest-figure__server" /><b>{t("Nest")}</b><span className="kob-status"><i className="kob-dot is-ok" />{t("Available")}</span></div>
    </div>}
  >
    <div className="kob-form kob-nest-form">
      <div className="kob-rows">
        {rows.map(nest => <div className="kob-row is-lead" key={nest.instanceId || nest.url}>
          <Icon name="server" />
          <span className="kob-nest-name"><b>{nest.name}</b><span className="kob-mono kob-muted">{hostOf(nest.url)} · {nest.version ? `v${nest.version}` : <Missing kind="nodata" />}</span></span>
          <span className="kob-status kob-nest-status" title={t("Found on your network; answered a moment ago")}><i className="kob-dot is-ok" />{t("Available")}</span>
          <button type="button" className="kob-btn kob-btn--coral" disabled={busy} title={t("Use this nest; Flipspin restarts connected to it")} onClick={() => void commit(nest.url)}>{t("Connect")}</button>
        </div>)}
        <div className="kob-row">
          <Icon name="laptop" />
          <span className="kob-nest-name"><b>{t("This computer")}</b><span className="kob-mono kob-muted">{device ?? <Missing kind="nodata" />}</span></span>
          <span className="kob-status kob-nest-status" title={t("This computer doesn’t keep music for other devices yet")}><i className="kob-dot is-off" />{t("No nest")}</span>
          <button type="button" className="kob-btn" disabled={busy} title={t("Flipspin keeps your music and account on this computer. Your other devices connect to it.")} onClick={() => void commit(null)}>{t("Make the nest here")}</button>
        </div>
      </div>
      {nests === null && <span role="status" className="kob-muted">{t("Searching…")}</span>}
      {byAddress ? <form className="kob-field" onSubmit={event => { event.preventDefault(); void probe() }}>
        <label className="kob-label kob-label--tip" htmlFor="kob-address" title={t("A nest that’s already set up but isn’t listed: over a VPN or Tailscale")}>{t("Address")}</label>
        <div className="kob-nest-address">
          <input className="kob-input kob-input--mono" id="kob-address" value={address} placeholder="192.168.1.20:8000" autoFocus spellCheck={false} onChange={event => setAddress(event.target.value)} />
          <button className="kob-btn" disabled={checking || !address.trim()} title={t("Checks that a Flipspin nest answers at that address")}>{checking ? t("Searching…") : t("Test")}</button>
        </div>
        <button type="button" className="kob-link" onClick={() => { setByAddress(false); setProblem(null) }}>{t("Use a setup link")}</button>
      </form> : <form className="kob-field" onSubmit={event => { event.preventDefault(); void connectLink() }}>
        <label className="kob-label kob-label--tip" htmlFor="kob-setup-link" title={t("The line the installer printed on your server")}>{t("Setup link")}</label>
        <div className="kob-nest-address">
          <input className="kob-input kob-input--mono" id="kob-setup-link" value={link} placeholder="krobi://192.168.1.20:8000/setup#…" autoFocus={join} autoComplete="off" spellCheck={false} onChange={event => { setLink(event.target.value); setProblem(null) }} />
          <button className="kob-btn" disabled={busy || !link.trim()} title={t("Connects to the nest in the link; its setup code comes along")}>{t("Connect")}</button>
        </div>
        <button type="button" className="kob-link" title={t("For a nest that’s already set up but isn’t listed: over a VPN or Tailscale")} onClick={() => { setByAddress(true); setProblem(null) }}>{t("Enter an address instead")}</button>
      </form>}
      {headerOrigin ? <details><summary>{t("Custom headers")}</summary><CustomHeaders key={headerOrigin} origin={headerOrigin} setup /></details> : null}
      <div className={installOpen ? 'kob-nest-install' : undefined}>
        <button type="button" className="kob-btn kob-btn--ghost kob-nest-install__toggle" aria-expanded={installOpen} aria-controls="kob-install" title={t("For an always-on nest on a NAS or a server")} onClick={() => setInstallOpen(open => !open)}>
          {!installOpen && <Icon name="terminal" />}{t("Install on a server")}
        </button>
        {installOpen && <div id="kob-install" className="kob-nest-install__body">
          <div className="kob-code"><code title={INSTALL_COMMAND}>{INSTALL_COMMAND}</code><CopyButton look="wizard" text={INSTALL_COMMAND} /></div>
          <div className="kob-nest-install__facts kob-mono kob-muted">
            <span title={t("A Linux server with Docker: NAS, Proxmox, a mini PC")}>{t("Linux · Docker")}</span>
            <span title={t("Size of the image the installer downloads")}>{t("≈ 930 MB")}</span>
            <details><summary title={t('Docker Compose, Unraid, systemd')}>{t("Other methods")}</summary><div className="kob-code"><code>{DOCKER_COMMAND}</code><CopyButton look="wizard" text={DOCKER_COMMAND} /></div></details>
          </div>
          <span>{t("When it finishes, it prints a setup link. Paste it above.")}</span>
        </div>}
      </div>
      {problem && <div role="alert" className="kob-alert">{t(problem, { app: APP_NAME })}</div>}
    </div>
  </WizardFrame>
}
