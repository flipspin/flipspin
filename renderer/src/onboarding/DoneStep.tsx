/** Completion persists before navigation opens the app or another setup destination. */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { apiPut, queryKeys, isApiError, serverDetail } from '../data'
import { APP_NAME } from '../brand'
import { Button } from '../ui/react/components/Button'
import { Missing } from '../ui/react/components/Missing'
import { navigate } from '../shell/routeStore'
import { openSettings } from '../shell/ServerBadge'
import { WizardFrame } from './Shell'
import { AlbumTiles } from './MusicStep'
import type { AddonId } from './AddonsStep'
import type { StepId } from './plan'
import './steps.css'

export interface DoneStepProps {
  nestName: string
  onNameChange: (name: string) => void
  onChange: (step: StepId) => void
  username: string
  songs: number | null
  albums: string[]
  addons: AddonId[]
  serverUrl: string
  remote: 'tailscale' | 'local' | null
  host: React.ReactNode
  onBack: () => void
  onFinished: () => void
}

export function DoneStep({ nestName, onNameChange, onChange, username, songs, albums, addons, serverUrl, remote, host, onBack, onFinished }: DoneStepProps): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  async function finish(phone = false) {
    if (busy || !nestName.trim()) return
    setBusy(true)
    setProblem(null)
    try {
      await apiPut('/api/server/name', { body: { name: nestName.trim() } })
      await apiPut('/api/server/setup', { body: { done: true } })
      void queryClient.invalidateQueries({ queryKey: queryKeys.server.all })
      if (phone) navigate('settings')
      onFinished()
      // Settings navigation waits for AuthGate to refresh identity and mount the app.
      if (phone) {
        let opened = false
        const reveal = () => {
          if (!opened && document.querySelector('.settings-nav')) {
            opened = true
            setTimeout(() => openSettings('dispositivos'), 0)
          }
          const devices = document.getElementById('aj-dispositivos')
          if (!opened || !devices) return false
          devices.scrollIntoView?.({ block: 'center' })
          devices.focus()
          return true
        }
        const observer = new MutationObserver(() => { if (reveal()) observer.disconnect() })
        observer.observe(document.body, { childList: true, subtree: true })
        if (reveal()) observer.disconnect()
        setTimeout(() => observer.disconnect(), 10_000)
      }
    } catch (error) {
      setProblem(isApiError(error) && error.status === 422 ? (serverDetail(error) ?? t("Invalid name.")) : t("Could not save setup. Try again."))
    } finally { setBusy(false) }
  }

  const rows: { id: StepId; label: string; value: React.ReactNode; ok: boolean; tip: string }[] = [
    { id: 'nest', label: t("Nest"), value: <>{nestName} · {serverUrl ? serverUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '') : <Missing kind="nodata" />}</>, ok: !!serverUrl, tip: t("Change picks the nest again") },
    { id: 'account', label: t("Account"), value: <>{username || <Missing kind="nodata" />} · {t('Admin')}</>, ok: !!username, tip: t("Changes the username; doesn’t create another account") },
    { id: 'music', label: t("Music"), value: songs === null ? <Missing kind="nodata" /> : t("{{n}} songs", { count: songs, n: songs.toLocaleString('en-US') }), ok: songs !== null && songs > 0, tip: t("Songs found in the nest’s folder") },
    { id: 'remote', label: t("Away from home"), value: remote === 'tailscale' ? `Tailscale · ${t("Connected_masculine")}` : t("Local network only"), ok: remote === 'tailscale', tip: t("What you chose in Remote · Settings → Remote access") },
    { id: 'addons', label: t("Engines"), value: addons.length ? addons.map(id => id === 'lyrics' ? t("Lyrics_plural") : id === 'stems' ? t('Stems') : t("Analysis")).join(', ') : t("None"), ok: addons.length > 0, tip: t("Lyrics, Stems and Analysis · also in Settings → Engines") },
  ]

  return <WizardFrame step="done" host={host} title={t("You’re all set")} show={<AlbumTiles albums={albums} />}
    back={<Button className="kob-btn kob-btn--ghost" variant="ghost" disabled={busy} onClick={onBack}>{t("Back")}</Button>}
    actions={<Button className="kob-btn kob-btn--coral" variant="primary" loading={busy} disabled={!nestName.trim()} onClick={() => void finish()}>{t("Open {{app}}", { app: APP_NAME })}</Button>}
  >
    <div className="kob-form kob-done">
      <div className="kob-field"><label className="kob-label" htmlFor="kob-nest-name">{t("Nest name")}</label><input className="kob-input" id="kob-nest-name" value={nestName} maxLength={60} disabled={busy} onChange={e => onNameChange(e.target.value)} /></div>
      <div className="kob-rows kob-review">
        {rows.map(row => <div className="kob-row" key={row.id} title={row.tip}>
          <span className={`kob-dot ${row.ok ? 'is-ok' : 'is-off'}`} aria-hidden="true" />
          <span className="kob-review-label kob-muted">{row.label}</span><strong>{row.value}</strong>
          <Button className="kob-btn kob-btn--sm" size="sm" disabled={busy} aria-label={t(row.id === 'addons' ? "Add {{step}}" : "Change {{step}}", { step: row.label })} onClick={() => onChange(row.id)}>{row.id === 'addons' ? t("Add") : t("Change", {  })}</Button>
        </div>)}
        <div className="kob-row" title={t("A Subsonic app with your username and an app password · Settings → My devices. Flipspin’s own apps are coming soon")}>
          <span className="kob-dot is-off" aria-hidden="true" /><span className="kob-review-label kob-muted">{t("Phone")}</span><strong>{t("Not connected")}</strong>
          <Button className="kob-btn kob-btn--sm" size="sm" disabled={busy || !nestName.trim()} onClick={() => void finish(true)}>{t("Connect")}</Button>
        </div>
      </div>
      {problem && <div role="alert" className="kob-alert">{problem}</div>}
    </div>
  </WizardFrame>
}
