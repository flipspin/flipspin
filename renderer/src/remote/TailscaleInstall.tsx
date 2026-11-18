import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { useServerHost } from '../data'
import { Button } from '../ui/react/components/Button'
import { CopyButton } from '../onboarding/CopyButton'
import { openExternal } from '../ui/components/cardArt'

const ALL_DOWNLOADS = 'https://tailscale.com/download'
const LINUX_COMMANDS = ['curl -fsSL https://tailscale.com/install.sh | sh', 'sudo tailscale up'] as const

export type TailscaleSteps =
  | { kind: 'commands'; lines: readonly string[] }
  | { kind: 'download'; url: string; os: string | null }

/**
 * How to install Tailscale on the nest's computer, from the system the nest itself reports.
 * The install script and sudo exist only on Linux; Windows and macOS get the download page.
 * An unknown system gets the page that lists every download rather than a command that may not run.
 */
export function tailscaleSteps(os: string | null | undefined): TailscaleSteps {
  if (os === 'Windows') return { kind: 'download', url: 'https://tailscale.com/download/windows', os }
  if (os === 'macOS') return { kind: 'download', url: 'https://tailscale.com/download/mac', os }
  if (os) return { kind: 'commands', lines: LINUX_COMMANDS }
  return { kind: 'download', url: ALL_DOWNLOADS, os: null }
}

/**
 * The install step for the nest's computer; shown only to the nest's owner.
 * `elsewhere` is true when this computer is not the nest's: it then needs Tailscale too,
 * to reach the nest away from home.
 */
export function TailscaleInstall({ look, elsewhere = false, signIn = true }: { look: 'settings' | 'wizard'; elsewhere?: boolean; signIn?: boolean }): React.JSX.Element | null {
  const { t } = useTranslation()
  const host = useServerHost(true)
  if (host.isPending) return null
  const steps = tailscaleSteps(host.data?.os?.name)
  // Every system's steps, for installing on another machine; not needed when the generic page is the step itself.
  const otherSystems = steps.kind === 'download' && steps.os === null ? null
    : <button type="button" className="ks-link" title={t("Install Tailscale on another machine")} onClick={() => openExternal(ALL_DOWNLOADS)}>{t("Other systems")}</button>
  const thisComputer = elsewhere
    ? <button type="button" className="ks-link" title={t("To reach the nest away from home")} onClick={() => openExternal(ALL_DOWNLOADS)}>{t("Tailscale for this computer")}</button>
    : null
  const links = otherSystems || thisComputer ? <div className="kob-links">{otherSystems}{thisComputer}</div> : null
  if (steps.kind === 'download') {
    return <div className="kob-stack">
      <Button size="sm" icon={<ExternalLink size={14} aria-hidden="true" />} className={look === 'wizard' ? 'kob-btn kob-btn--sm kob-self-start' : 'kob-self-start'} onClick={() => openExternal(steps.url)}>
        {t("Download Tailscale")}
      </Button>
      {signIn ? <span className="kob-muted">{t("Then open Tailscale and sign in.")}</span> : null}
      {links}
    </div>
  }
  return <>{steps.lines.map(line => look === 'wizard'
    ? <div className="kob-code" key={line}><code>{line}</code><CopyButton look="wizard" text={line} /></div>
    : <div key={line} className="kob-cmd"><span>$</span><code>{line}</code><CopyButton text={line} /></div>)}{links}</>
}
