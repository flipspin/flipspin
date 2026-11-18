/** Two choices; address verification and persistence share the Settings gateway. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/react/components/Button'
import { Missing } from '../ui/react/components/Missing'
import { networkReach, saveRemoteRoute, useNestAddresses, VERDICT_WORD } from '../remote/useNestAddresses'
import { QueryFailure } from '../settings/parts'
import { CopyButton } from './CopyButton'
import { WizardFrame } from './Shell'
import './steps.css'

export interface RemoteStepProps {
  nestName: string
  host: React.ReactNode
  onBack: () => void
  onDone: (route: 'tailscale' | 'local') => void
}

export function RemoteStep({ nestName, host, onBack, onDone }: RemoteStepProps): React.JSX.Element {
  const { t } = useTranslation()
  const nest = useNestAddresses('')
  const [choice, setChoice] = useState<'tailscale' | 'local' | null>(null)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const tail = nest.network?.tailscale
  const verdict = tail ? nest.stateOf(tail.url) : null
  const connected = networkReach(nest.network, nest.stateOf, 'tailscale').reach === 'ok'
  const status = !nest.network ? t("Checking…") : !tail ? t("Not detected") : verdict === 'busy' ? t("Checking…") : verdict ? t(VERDICT_WORD[verdict], { app: 'Flipspin' }) : connected ? t("Connected_masculine") : t("Detected")
  async function finish(skip = false) {
    if (saving) return
    const route = !skip && choice === 'tailscale' && connected ? 'tailscale' : 'local'
    setSaving(true)
    setProblem(null)
    try {
      await saveRemoteRoute(route)
      await nest.refresh()
      onDone(route)
    } catch (error) { setProblem(t((error as Error).message)) }
    finally { setSaving(false) }
  }
  return <WizardFrame step="remote" host={host} title={t("Away from home")}
    show={<div className="kob-away" aria-label={t("The phone reaches the nest over Tailscale")}>
      <div className="kob-away-end"><span className="kob-away-phone" /><b>{t("Phone")}</b><small className="kob-mono kob-muted">{t("away from home_away")}</small></div>
      <div className="kob-away-link"><small className="kob-mono">{t("Tailscale")}</small><span /></div>
      <div className="kob-away-end"><span className="kob-away-nest" /><b title={nestName}>{t("Nest")}</b><span className="kob-status"><span className={`kob-dot ${connected ? 'is-ok' : 'is-off'}`} />{connected ? t("Connected_masculine") : t("Not checked")}</span></div>
    </div>}
    back={<Button className="kob-btn kob-btn--ghost" variant="ghost" disabled={saving} onClick={onBack}>{t("Back")}</Button>}
    actions={<>
      <Button className="kob-btn kob-btn--ghost" variant="ghost" disabled={saving} title={t("Available later in Settings → Remote access.")} onClick={() => void finish(true)}>{t("Skip")}</Button>
      <Button className="kob-btn kob-btn--coral" variant="primary" loading={saving} onClick={() => void finish()}>{t("Next")}</Button>
    </>}
  >
    <div className="kob-form">
      <div className="kob-remote-options" role="radiogroup" aria-label={t("Remote access")}>
        <label className={`kob-option kob-remote-option${choice === 'tailscale' ? ' is-picked' : ''}`} title={t("Private network between your devices. Opens no ports on the router")}>
          <span className="kob-option-head"><input type="radio" name="remote-route" value="tailscale" checked={choice === 'tailscale'} disabled={saving} onChange={() => setChoice('tailscale')} /><b>{t("Use Tailscale")}</b></span>
          <span className="kob-status"><span className={`kob-dot ${connected ? 'is-ok' : 'is-off'}`} aria-hidden="true" />{status}</span>
          <span className="kob-mono kob-muted" title={tail?.url}>{tail ? tail.name ?? tail.ip : <Missing kind="notSet" />}</span>
        </label>
        <label className={`kob-option kob-remote-option${choice === 'local' ? ' is-picked' : ''}`} title={t("Only on your local network. Change it any time in Settings → Remote access")}>
          <span className="kob-option-head"><input type="radio" name="remote-route" value="local" checked={choice === 'local'} disabled={saving} onChange={() => setChoice('local')} /><b>{t("Later")}</b></span>
          <span>{t("Local network only")}</span>
        </label>
      </div>
      <span className="kob-tip kob-muted" title={t("WireGuard on your router, or your own domain")}>{t("Other ways in Settings → Remote access")}</span>
      {nest.error && <QueryFailure error={nest.error} what={t("the nest’s addresses")} onRetry={() => void nest.refresh()} />}
      {choice === 'tailscale' && nest.network && !tail && <div className="kob-remote-install">
        <span className="kob-k kob-tip" title={t("On the nest's computer. Then Tailscale on the phone, with the same account.")}>{t("Install on the nest’s computer")}</span>
        {['curl -fsSL https://tailscale.com/install.sh | sh', 'sudo tailscale up'].map(line => <div className="kob-code" key={line}><code>{line}</code><CopyButton look="wizard" text={line} /></div>)}
        <Button className="kob-btn kob-btn--sm" size="sm" onClick={() => void nest.refresh()}>{t("Retry")}</Button>
      </div>}
      {choice === 'tailscale' && tail && <Button className="kob-btn kob-btn--sm kob-check-remote" size="sm" loading={nest.checking} onClick={() => void nest.check([tail.url])}>{t("Check_review")}</Button>}
      {problem && <div className="kob-alert" role="alert">{problem}</div>}
    </div>
  </WizardFrame>
}
