/**
 * "Remote access" (docs/features/remote-access.md): four ways out of the local
 * network; Tailscale, WireGuard, a domain with HTTPS, or none; and a check of
 * every address the nest answers at. Port 8000 is never one of them.
 *
 * The picture is the chain phone → the way out → the nest, a mark on each link.
 * The wizard saves only a verified domain. Settings also permits an unreachable
 * domain (hairpin NAT) and provides removal with undo.
 */
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { msg } from '../i18n'
import { Button } from '../ui/react/components/Button'
import { Field } from '../ui/react/components/Field'
import { Input } from '../ui/react/components/Input'
import { AddressList, ReachLine } from './AddressList'
import { inferredRoute, normalizeExternalUrl, type LinkState, type Route } from './rules'
export type { Route } from './rules'
import { reachWord } from './reachWord'
import {
  EXTERNAL_URL_ERROR,
  lanHostPort,
  saveExternalUrl,
  networkReach,
  saveRemoteRoute,
  reachKey,
  useNestAddresses,
  type RowKind,
} from './useNestAddresses'
import { CopyButton } from '../onboarding/CopyButton'
import { Icon } from '../onboarding/Shell'
import { QueryFailure, Skel, useToast } from '../settings/parts'
import { rememberReach } from '../settings/reachMemo'

const TAILSCALE_INSTALL = ['curl -fsSL https://tailscale.com/install.sh | sh', 'sudo tailscale up'] as const

const ROUTES = [
  { id: 'tailscale', icon: 'tailnet', title: msg('Tailscale'), sub: msg("Recommended"), tip: msg("A private network between your devices. Opens no ports on the router.") },
  { id: 'wireguard', icon: 'lock', title: msg('WireGuard'), sub: msg("Router's VPN"), tip: msg("The router's VPN. With the VPN on, the phone uses the local address.") },
  { id: 'domain', icon: 'globe', title: msg("Domain with HTTPS"), sub: msg("Advanced"), tip: msg("Your own domain with an HTTPS certificate, behind Caddy. Open 80 and 443 to Caddy, never 8000.") },
  { id: 'local', icon: 'house', title: msg("Local network only"), sub: msg("no outside access"), tip: null },
] as const

const ROUTE_ROW: Record<Route, RowKind | null> = { tailscale: 'tailscale', wireguard: 'lan', domain: 'domain', local: null }

function LinkIcon({ state }: { state: LinkState }): React.JSX.Element {
  return <svg viewBox="0 0 24 24">{state === 'ok' ? <path d="m5 12 4 4L19 6" /> : state === 'bad' ? <path d="m6 6 12 12M6 18 18 6" /> : state === 'none' ? <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></> : <path d="M6 12h12" />}</svg>
}

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

export interface RemoteSetupView {
  picture: React.ReactNode
  content: React.ReactNode
  saving: boolean
  next: () => Promise<void>
  skip: () => void
}

export interface RemoteSetupProps {
  nestName: string
  settings?: boolean
  readOnly?: boolean
  onDone?: (route: Route) => void
  children: (view: RemoteSetupView) => React.ReactNode
}

export function RemoteSetup({ nestName, settings = false, readOnly = false, onDone, children }: RemoteSetupProps): React.JSX.Element {
  const { t } = useTranslation()
  const [choice, setChoice] = useState<Route | null>(null)
  const toast = useToast()
  const [text, setText] = useState<string | null>(settings ? null : '')
  const [touched, setTouched] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const parsed = useMemo(() => normalizeExternalUrl(text ?? ''), [text])
  const draft = 'url' in parsed ? parsed.url : null
  const fieldError = (touched || (settings && text !== null)) && 'error' in parsed ? t(EXTERNAL_URL_ERROR[parsed.error]) : null

  const nest = useNestAddresses(text === null ? undefined : draft)
  const { network, rows, stateOf } = nest
  const tailscale = network?.tailscale ?? null
  const storedDomain = saved ?? network?.externalUrl ?? null
  const domain = draft ?? storedDomain

  const route = choice ?? (settings ? inferredRoute({ route: network?.route ?? null, tailscale: !!tailscale, domain: !!storedDomain }) : 'local')
  const result = networkReach(network, stateOf, route, storedDomain)
  const reach = result.reach
  async function setRoute(value: Route) {
    if (readOnly || saving) return
    if (!settings) { setChoice(value); return }
    setSaving(true)
    setProblem(null)
    try {
      await saveRemoteRoute(value)
      setChoice(value)
      await nest.refresh()
    } catch (error) {
      setProblem((error as Error).message)
    } finally { setSaving(false) }
  }
  useEffect(() => {
    if (settings && network && !nest.checking) {
      rememberReach(reach, reachKey(network, nest.instanceId))
      if (reach === 'ok') {
        try { localStorage.removeItem(`krobi.setup-remote.${nest.instanceId}`) } catch { /* session only */ }
      }
    }
  }, [settings, network, nest.checking, nest.instanceId, reach])
  const domainState = domain ? stateOf(domain) : null
  const canSave = draft !== null && draft !== storedDomain && (domainState === 'same-nest' || (settings && domainState === 'unreachable'))

  async function save(url: string | null = draft, undo = true): Promise<boolean> {
    if (!url && !settings) return true
    setSaving(true)
    setProblem(null)
    try {
      const previous = storedDomain
      setSaved(await saveExternalUrl(url))
      await nest.refresh()
      if (settings) {
        setText(null)
        toast(url ? t("Domain saved") : t("Domain removed"), undo ? { undo: () => void save(previous, false) } : {})
      }
      return true
    } catch (error) {
      setProblem((error as Error).message)
      return false
    } finally {
      setSaving(false)
    }
  }

  async function next() {
    if (saving) return
    if (route === 'domain' && canSave && !(await save())) return
    const finished = reach === 'ok' ? route : 'local'
    setSaving(true)
    setProblem(null)
    try {
      await saveRemoteRoute(finished)
      await nest.refresh()
      onDone?.(finished)
    } catch (error) { setProblem((error as Error).message) }
    finally { setSaving(false) }
  }

  async function skip() {
    if (saving) return
    setSaving(true)
    setProblem(null)
    try {
      await saveRemoteRoute('local')
      await nest.refresh()
      setChoice('local')
      onDone?.('local')
    } catch (error) { setProblem((error as Error).message) }
    finally { setSaving(false) }
  }

  // ── the picture: phone · the way out · the nest ──
  const mid = {
    tailscale: [t('Tailscale'), tailscale ? (tailscale.name ?? tailscale.ip) : t("not installed"), t("no open ports")],
    wireguard: [t('WireGuard'), t("Router's VPN"), '51820/udp → router'],
    domain: [t('Caddy · HTTPS'), domain ? hostOf(domain) : t("no domain"), '80 · 443 → Caddy'],
    local: [t('Internet'), t("no access"), t("no open ports")],
  }[route]
  const icon = { tailscale: 'tailnet', wireguard: 'lock', domain: 'globe', local: 'cross' } as const

  function chainLink(index: 0 | 1) {
    const link = result.links[index]
    return <div className="kob-chain__link" data-v={link.state}>
      <span className="kob-chain__line" />
      <span className="kob-chain__mark" aria-hidden="true">
        <LinkIcon state={link.state} />
      </span>
      <span className="kob-chain__word">{reachWord(t, link.word)}</span>
    </div>
  }

  const show = (
    <div className="kob-chain" data-route={route}>
      <div className="kob-chain__end">
        <span className="kob-chain__node">
          <Icon name="phone" />
        </span>
        <b>{t("Phone")}</b>
        <span className="kob-chain__sub">{t("away from home")}</span>
      </div>
      {chainLink(0)}
      <div className="kob-chain__end">
        <span className="kob-chain__node kob-chain__node--sm">
          <Icon name={icon[route]} />
        </span>
        <b>{mid[0]}</b>
        <span className="kob-chain__sub">{mid[1]}</span>
      </div>
      {chainLink(1)}
      <div className="kob-chain__end kob-chain__end--home">
        <span className="kob-chain__home">
          {t("local network")} · <span>{mid[2]}</span>
        </span>
        <span className="kob-chain__node"><Icon name="house" /></span>
        <b>{nestName}</b>
        <span className="kob-chain__sub">{lanHostPort(network)}</span>
      </div>
    </div>
  )

  const caddyfile = `${domain ? hostOf(domain) : 'musica.ejemplo.com'} {\n\treverse_proxy ${lanHostPort(network)}\n}`

  const content = (
    <>
      <ReachLine reach={reach} detail={result.detail === null ? undefined : `${t(ROUTES.find(r => r.id === route)!.title)} · ${reachWord(t, result.detail)}`} />

      <div className="kob-choices kob-choices--4" role="radiogroup" aria-label={t("Remote access")}>
        {(settings ? ROUTES : [
          { ...ROUTES[0], title: msg("Use Tailscale"), sub: msg("Recommended") },
          { ...ROUTES[3], title: msg("Later"), sub: msg("Local network only") },
        ]).map((r, k) => (
          <button
            key={r.id}
            type="button"
            role="radio"
            aria-checked={(settings ? route : choice) === r.id}
            disabled={readOnly || saving}
            className="kob-choice"
            data-tip={!settings && r.tip ? t(r.tip) : undefined}
            title={settings && r.tip ? t(r.tip) : undefined}
            data-tip-pos={k % 2 === 1 ? 'end' : undefined}
            onClick={() => void setRoute(r.id)}
          >
            <span className="kob-choice__icon">
              <Icon name={r.icon} />
              {(settings ? route : choice) === r.id && result.links[0].state !== 'off' && <span className="kob-choice__badge" data-v={result.links[0].state} aria-hidden="true">
                <LinkIcon state={result.links[0].state} />
              </span>}
            </span>
            <b>{t(r.title)}</b>
            <span>{t(r.sub)}</span>
          </button>
        ))}
      </div>

      {!readOnly && route === 'tailscale' && network && !tailscale ? (
        <div className="kob-stack">
          <span className="kob-status">
            <span className="kob-dot is-bad" />
            {t("Not detected")}
          </span>
          <span className="kob-k">
            <span className="kob-q" tabIndex={0} data-tip={!settings ? t("On the nest's computer. Then Tailscale on the phone, with the same account.") : undefined} title={settings ? t("On the nest's computer. Then Tailscale on the phone, with the same account.") : undefined}>
              {t("Install on the nest’s computer")}
            </span>
          </span>
          {TAILSCALE_INSTALL.map((line) => (
            <div key={line} className="kob-cmd">
              <span>$</span>
              <code>{line}</code>
              <CopyButton text={line} />
            </div>
          ))}
          <Button size="sm" className="kob-self-start" onClick={() => void nest.refresh()}>
            {t("Retry")}
          </Button>
        </div>
      ) : null}

      {!readOnly && route === 'tailscale' && tailscale ? (
        <span className="kob-status"><span className="kob-dot is-ok" />{t("Detected")} · {tailscale.name ?? tailscale.ip}<CopyButton text={tailscale.url} /></span>
      ) : null}

      {!readOnly && route === 'domain' ? (
        <div className="kob-stack">
          <Field label={t("Domain")} htmlFor="kob-domain" error={fieldError ?? undefined}>
            <div className="kob-addr">
              <Input
                id="kob-domain"
                mono
                value={text ?? (storedDomain?.replace(/^https:\/\//, '') ?? '')}
                placeholder="musica.ejemplo.com"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => {
                  setText(e.target.value)
                  setProblem(null)
                }}
                onBlur={() => setTouched(true)}
              />
              <Button loading={saving} disabled={!canSave} onClick={() => void save()}>
                {t("Save")}
              </Button>
              {settings && storedDomain && text === null ? <Button size="sm" variant="ghost" loading={saving} onClick={() => void save(null)}>{t("Remove")}</Button> : null}
            </div>
          </Field>
          <div className="kob-cmd kob-cmd--block">
            <code>
              <span className="kob-cmd__file">Caddyfile</span>
              {caddyfile}
            </code>
            <CopyButton text={caddyfile} nativeTip={settings} tip={t("Caddy gets the HTTPS certificate on its own.")} />
          </div>
        </div>
      ) : null}

      {problem ? (
        <div role="alert" className="kob-alert">
          {t(problem)}
        </div>
      ) : null}

      {(settings || choice === 'tailscale') && <AddressList
        rows={settings ? rows : rows.filter(row => row.kind === 'tailscale')}
        stateOf={stateOf}
        onCheck={() => {
          setTouched(true)
          void nest.check(settings ? undefined : rows.filter(row => row.kind === 'tailscale').map(row => row.url))
        }}
        checking={nest.checking}
        active={ROUTE_ROW[route]}
        tipAttr={settings ? 'title' : 'data-tip'}
        readOnly={readOnly}
      />}

      {settings && <span className="kob-warn">
        <Icon name="shieldOff" />
        {t("Don't open port 8000 on your router.")}
      </span>}
    </>
  )
  const shownContent = settings && nest.loading ? <Skel rows={3} label={t("Loading the nest’s addresses")} />
    : settings && nest.error ? <QueryFailure error={nest.error} what={t("the nest’s addresses")} older={t("Update the nest to use remote access.")} onRetry={() => void nest.refresh()} />
    : !settings && nest.loading ? <p role="status">{t("Loading the nest’s addresses")}…</p>
    : !settings && nest.error ? <QueryFailure error={nest.error} what={t("the nest’s addresses")} onRetry={() => void nest.refresh()} />
    : content
  return <>{children({ picture: settings && !network ? null : show, content: shownContent, saving, next, skip: () => void skip() })}</>
}
