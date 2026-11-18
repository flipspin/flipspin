import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { apiPost, isApiError, useServerHost } from '../data'
import { useOffline } from '../offline/useOffline'
import { Missing } from '../ui/react/components/Missing'
import { Skel, Word, useToast } from './parts'

export function BackupRow({ host }: { host: ReturnType<typeof useServerHost> }): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const offline = useOffline()
  const [busy, setBusy] = useState(false)
  const at = host.data?.lastBackupAt
  const seconds = at ? Math.max(0, (Date.now() - Date.parse(at)) / 1000) : null
  const valid = seconds !== null && Number.isFinite(seconds)
  const age = !valid ? t("Never") : seconds < 60 ? t("Just now")
    : seconds < 3600 ? t("{{n}} min ago", { n: Math.floor(seconds / 60) })
      : seconds < 86400 ? t("{{n}} h ago", { n: Math.floor(seconds / 3600) })
        : t("{{n}} d ago", { n: Math.floor(seconds / 86400) })

  const backup = async () => {
    setBusy(true)
    try {
      await apiPost('/api/server/backups')
      await host.refetch()
      toast(t("Backup created"))
    } catch (error) {
      toast(isApiError(error) && error.status === 409 ? t("A backup is already running") : t("Could not create backup"), { err: true })
    } finally {
      setBusy(false)
    }
  }

  return <div>
    <dt>{t("Last backup")}</dt>
    <dd><span className="settings-meterline">
      {host.isPending ? <Skel rows={1} label={t("Loading backup")} />
        : host.isError || at === undefined || at !== null && !valid ? <Missing kind="unavailable" />
          : <Word tone={valid && seconds < 2 * 86400 ? 'ok' : 'warn'} title={[at, host.data?.lastBackupReason].filter(Boolean).join(' · ')}>{age}</Word>}
      <button className="ks-btn ks-btn--sm" type="button" disabled={busy || offline} onClick={() => void backup()}>
        {busy ? t("Backing up…") : t("Back up now")}
      </button>
    </span></dd>
  </div>
}
