/**
 * Settings → Remote access: each way out as three numbered steps (this computer,
 * the phone, the music app), each marked done from what the nest itself reports.
 * The setup details live in an ⓘ beside the step they belong to.
 *
 * A step is done only when the nest can tell: Tailscale has an address on this
 * computer; a phone has reached the nest through that route (`outside.via`).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ExternalLink, Info } from 'lucide-react'

import { msg } from '../i18n'
import { queryKeys, useServerHost } from '../data'
import { useQueryClient } from '@tanstack/react-query'
import { useSettings } from '../settings/context'
import { useMyDevices } from '../settings/data'
import { isMusicApp } from '../settings/gateways'
import { SubsonicDeviceDialog } from '../pairing/SubsonicDeviceDialog'
import { Button } from '../ui/react/components/Button'
import { Modal } from '../settings/parts'
import { Tooltip } from '../ui/react/components/Tooltip'
import { CopyButton } from '../onboarding/CopyButton'
import { openExternal } from '../ui/components/cardArt'
import { QrCode } from '../pairing/QrCode'
import { TailscaleInstall } from './TailscaleInstall'
import type { Route } from './rules'
import type { ServerNetwork } from './useNestAddresses'

const TAILSCALE_ADMIN = 'https://login.tailscale.com/admin/machines'
const TAILSCALE_APP = 'https://tailscale.com/download'

const TITLE: Record<Route, string> = {
  tailscale: msg("Tailscale setup"),
  wireguard: msg("WireGuard setup"),
  domain: msg("Domain setup"),
  local: msg("Local network"),
}

const PRIVATE: readonly [number, number][] = [[0x0a000000, 8], [0xac100000, 12], [0xc0a80000, 16]]

/**
 * The route to advertise for the home network: the nest's own network one bit wider,
 * so on the home Wi-Fi the phone's own, narrower route wins and Tailscale steps aside.
 * Null for anything that is not a private IPv4 network with a prefix of 9..30 (the nest
 * reports only those), and for a nest too old to report its networks at all.
 */
export function homeRoute(lanNetworks: readonly string[] | undefined): string | null {
  const match = lanNetworks?.[0]?.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/)
  if (!match) return null
  const octets = match.slice(1, 5).map(Number)
  const prefix = Number(match[5])
  if (octets.some(o => o > 255) || prefix < 9 || prefix > 30) return null
  const ip = octets.reduce((n, o) => n * 256 + o, 0)
  const within = (base: number, bits: number) => Math.floor(ip / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits))
  if (!PRIVATE.some(([base, bits]) => within(base, bits))) return null
  const wider = prefix - 1
  const start = Math.floor(ip / 2 ** (32 - wider)) * 2 ** (32 - wider)
  return `${[24, 16, 8, 0].map(shift => Math.floor(start / 2 ** shift) % 256).join('.')}/${wider}`
}

function Hint({ text }: { text: string }): React.JSX.Element {
  return <Tooltip className="kob-hint" label={text} content={text}><Info size={14} aria-hidden="true" /></Tooltip>
}

/** An address the user types somewhere else, named for where it goes. */
function Address({ url, label }: { url: string; label: string }): React.JSX.Element {
  return <div className="kob-stack">
    <span className="kob-k">{label}</span>
    <div className="kob-cmd"><code>{url}</code><CopyButton look="soft" text={url} /></div>
  </div>
}

interface StepProps {
  n: number
  title: string
  done: boolean
  /** Not yet reachable: an earlier step comes first. */
  waiting?: boolean
  detail?: React.ReactNode
  hint?: string
  /** The step's one action, at the end of its heading. */
  action?: React.ReactNode
  children?: React.ReactNode
}

function Step({ n, title, done, waiting = false, detail, hint, action, children }: StepProps): React.JSX.Element {
  const { t } = useTranslation()
  return <li className="kob-step" data-state={done ? 'done' : waiting ? 'waiting' : 'now'}>
    <span className="kob-step__n" aria-label={done ? t("Done") : undefined}>{done ? <Check size={14} aria-hidden="true" /> : n}</span>
    <div className="kob-step__body">
      <div className="kob-step__head">
        <b>{title}</b>
        {hint ? <Hint text={hint} /> : null}
        {detail ? <span className="kob-muted">{detail}</span> : null}
        {action && !waiting ? <span className="kob-step__action">{action}</span> : null}
      </div>
      {waiting ? null : children}
    </div>
  </li>
}

/**
 * The last step everywhere: the music app needs the address and its own sign-in,
 * made in the same dialog as My devices → Music apps. Done once this account has one.
 */
function MusicAppStep({ n, url, waiting = false, hint }: { n: number; url: string | null | undefined; waiting?: boolean; hint?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const { me } = useSettings()
  const own = me?.source === 'token'
  const devices = useMyDevices(own)
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const added = (devices.data?.filter(isMusicApp).length ?? 0) > 0
  return <Step n={n} title={t("Add your music app")} done={added} waiting={waiting} hint={hint}
    action={url && own ? <Button variant="soft" onClick={() => setAdding(true)}>{t("Add a music app")}</Button> : null}>
    {url ? <Address url={url} label={t("Server address for your Subsonic app")} /> : null}
    {url && !own ? <span className="kob-muted">{t("Sign in with an account to add a music app.")}</span> : null}
    {adding && url ? <SubsonicDeviceDialog serverUrl={url} username={me?.username} onClose={() => setAdding(false)}
      onAdded={() => void queryClient.invalidateQueries({ queryKey: queryKeys.me.devices() })} /> : null}
  </Step>
}

export interface RouteStepsProps {
  route: Route
  network: ServerNetwork
  /** This computer is not the nest's own. */
  elsewhere: boolean
  onRetry: () => void
  /** The domain field and its Caddyfile, drawn by RemoteSetup. */
  domainField: React.ReactNode
  routerPorts: React.ReactNode
  domain: string | null
  storedDomain: string | null
  /** Probe the typed domain; an unreachable one may still be saved once checked. */
  onCheckDomain: () => void
  checking: boolean
}

export function RouteSteps({ route, network, elsewhere, onRetry, domainField, routerPorts, domain, storedDomain, onCheckDomain, checking }: RouteStepsProps): React.JSX.Element {
  const { t } = useTranslation()
  const [home, setHome] = useState(false)
  const host = useServerHost(true)
  const lan = network.lan[0]
  const tailscale = network.tailscale
  const via = network.outside?.via ?? null

  function card(title: string, steps: React.ReactNode, foot?: React.ReactNode) {
    return <section className="kob-steps" aria-label={title}>
      <ol>{steps}</ol>
      {foot ? <div className="kob-links">{foot}</div> : null}
    </section>
  }

  if (route === 'tailscale' && home) {
    const subnet = homeRoute(network.lanNetworks)
    const command = subnet ? `tailscale set --advertise-routes=${subnet}` : null
    return card(t("Home address"), <>
      <Step n={1} title={t("Share your home network")} done={false} hint={t("Run it on this computer, in a terminal opened as administrator.")}>
        {command ? <div className="kob-cmd"><span>$</span><code>{command}</code><CopyButton look="soft" text={command} /></div> : null}
      </Step>
      <Step n={2} title={t("Approve it on Tailscale")} done={false} hint={t("In Machines, open this computer, then Edit route settings.")}
        action={<Button variant="soft" icon={<ExternalLink size={14} aria-hidden="true" />} onClick={() => openExternal(TAILSCALE_ADMIN)}>{t("Open Tailscale")}</Button>} />
      <MusicAppStep n={3} url={lan} hint={t("Away, Tailscale carries it; on your home Wi-Fi it can stay off.")} />
    </>, <button type="button" className="ks-link" onClick={() => setHome(false)}>{t("Use the Tailscale address")}</button>)
  }

  if (route === 'tailscale') {
    // Tailscale answers with an address only once it is installed and signed in, so both steps finish together.
    const computer = !!tailscale
    const phone = via === 'tailscale'
    const windows = host.data?.os?.name === 'Windows'
    return card(t(TITLE.tailscale), <>
      <Step n={1} title={t("Install Tailscale on this computer")} done={computer} detail={computer ? t("Installed") : undefined}>
        {computer ? null : <TailscaleInstall look="settings" elsewhere={elsewhere} signIn={false} />}
      </Step>
      <Step n={2} title={t("Sign in on this computer")} done={computer} detail={tailscale ? (tailscale.name ?? tailscale.ip) : undefined}
        hint={t("Use the account you will use on your phone: Google, Microsoft, Apple or GitHub.")}>
        {computer ? null : <div className="kob-stack">
          <span className="kob-muted">{t("Open Tailscale and sign in.")}</span>
          <Button size="sm" className="kob-self-start" onClick={onRetry}>{t("Retry")}</Button>
        </div>}
      </Step>
      <Step n={3} title={t("Keep it running")} done={false} waiting={!computer}
        hint={t("Otherwise Tailscale signs this computer out after 180 days, and on Windows it stops when you sign out.")}
        action={<Button variant="soft" icon={<ExternalLink size={14} aria-hidden="true" />} onClick={() => openExternal(TAILSCALE_ADMIN)}>{t("Open Machines")}</Button>}>
        <ul className="kob-checks">
          {windows ? <li>{t("In Tailscale's menu, open Settings and turn on Run unattended.")}</li> : null}
          <li>{t("In Machines, open this computer and choose Disable key expiry.")}</li>
        </ul>
      </Step>
      <Step n={4} title={t("Install Tailscale on your phone")} done={phone} waiting={!computer}>
        {phone ? null : <div className="kob-qr">
          <QrCode payload={TAILSCALE_APP} size={96} label={t("Scan to get Tailscale.")} />
          <span className="kob-muted">{t("Scan to get Tailscale.")}</span>
        </div>}
      </Step>
      <Step n={5} title={t("Sign in on your phone")} done={phone} waiting={!computer} detail={phone ? t("Connected_masculine") : undefined}
        hint={phone ? t("Leave Tailscale on. VPN On Demand reconnects it by itself.") : undefined}>
        {phone ? null : <span className="kob-muted">{t("Same account as this computer. Allow the VPN prompt, then turn Tailscale on.")}</span>}
      </Step>
      <MusicAppStep n={6} url={tailscale?.url} waiting={!computer} hint={t("This address works at home too, straight over Wi-Fi.")} />
    </>, computer && homeRoute(network.lanNetworks) ? <Tooltip label={t("Away, Tailscale carries it; on your home Wi-Fi it can stay off.")} content={t("Away, Tailscale carries it; on your home Wi-Fi it can stay off.")}>
      <button type="button" className="ks-link" onClick={() => setHome(true)}>{t("Use my home address instead")}</button>
    </Tooltip> : null)
  }

  if (route === 'wireguard') {
    const phone = via === 'vpn'
    return card(t(TITLE.wireguard), <>
      <Step n={1} title={t("Router VPN")} done={phone} hint={t("Turn on the WireGuard VPN server in your router's settings. Some routers call it Teleport or VPN server.")}>
        {phone ? null : <span className="kob-muted">{t("On in your router.")}</span>}
      </Step>
      <Step n={2} title={t("Your phone")} done={phone} detail={phone ? t("Connected_masculine") : undefined}
        hint={t("Add the router's WireGuard config to the WireGuard app. Set it to switch on away from home and off on your home Wi-Fi.")} />
      <MusicAppStep n={3} url={lan} hint={t("With the VPN on, the phone uses the local address.")} />
    </>)
  }

  if (route === 'domain') {
    const outside = via === 'proxy'
    return card(t(TITLE.domain), <>
      <Step n={1} title={t("Your domain")} done={!!storedDomain}
        action={<Button variant="soft" loading={checking} disabled={!domain} onClick={onCheckDomain} title={t("Check that each address reaches this nest.")}>{t("Check_review")}</Button>}>{domainField}</Step>
      <Step n={2} title={t("Router ports")} done={outside} hint={t("Forward 80 and 443 to Caddy, never 8000. Caddy gets the HTTPS certificate on its own.")}>
        {routerPorts}
      </Step>
      <MusicAppStep n={3} url={domain} waiting={!storedDomain} />
    </>)
  }

  return card(t(TITLE.local), <MusicAppStep n={1} url={lan} hint={t("Works only on your home network.")} />)
}

/** Every step of the route is done, as far as the nest can tell. */
export function routeDone(route: Route, network: ServerNetwork, storedDomain: string | null): boolean {
  const via = network.outside?.via ?? null
  if (route === 'tailscale') return !!network.tailscale && via === 'tailscale'
  if (route === 'wireguard') return via === 'vpn'
  if (route === 'domain') return !!storedDomain && via === 'proxy'
  return true
}

export function routeTitle(route: Route): string {
  return TITLE[route]
}

/** The route's steps in a popup. */
export function RouteStepsModal({ onClose, ...props }: RouteStepsProps & { onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return <Modal title={t(routeTitle(props.route))} onClose={onClose} className="settings-modal--route-steps">
    <div className="settings-remote"><RouteSteps {...props} /></div>
    <div className="settings-modal__do"><Button data-autofocus onClick={onClose}>{t("Close")}</Button></div>
  </Modal>
}
