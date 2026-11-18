import { useTranslation } from 'react-i18next'
import { Missing } from '../../ui/react/components/Missing'
import { hasBridge } from '../../bridge'
import { useDesktopSession, useSaveSessionToFile } from '../../data/hooks/use-desktop-session'
import { formatSeen } from '../format'
import { QueryFailure, Skel, Word } from '../parts'

export function DesktopSession({ onSignOut, onDevices }: { onSignOut: () => void; onDevices?: () => void }) {
  const { t } = useTranslation()
  const query = useDesktopSession()
  const save = useSaveSessionToFile()
  if (!hasBridge()) return null
  const data = query.data
  const stores = {
    'macos-keychain': t("macOS Keychain"),
    'windows-credential-manager': t("Windows Credential Manager"),
    'secret-service': t("System keychain"),
    file: t("File on this computer"),
    memory: t("In memory until Flipspin closes"),
  }
  const states = { activa: t("Active"), rechazada: t("Rejected by the nest"), 'sin-conexion': t("Offline") }
  return <section className="settings-block ks-group" aria-label={t("Session on this computer")}>
    <div className="settings-block__head"><h3>{t("Session on this computer")}</h3></div>
    {query.isPending ? <Skel rows={5} /> : query.isError ? <QueryFailure error={query.error} what={t("this computer’s session")} onRetry={() => void query.refetch()} /> : data ? <div className="settings-block__body">
      {data.store === 'memory' ? <div className="ks-row"><div className="ks-l"><b title={data.reason ?? undefined}>{t("No system keychain · this session lasts until Flipspin closes")}</b></div><button className="ks-btn ks-btn--sm" type="button" disabled={save.isPending} onClick={() => void save.mutateAsync().catch(() => undefined)}>{t("Save to a file on this computer")}</button></div> : null}
      {save.isError ? <span className="z-err" role="alert">{t("Could not save the session")}</span> : null}
      <div className="ks-row"><div className="ks-l"><b>{t("Stored in")}</b><span>{stores[data.store]}</span></div></div>
      <div className="ks-row"><div className="ks-l"><b>{t("Nest")}</b><span>{data.nest.name || <Missing kind="nodata" />}</span><span className="z-mono">{data.nest.address || <Missing kind="nodata" />}</span></div></div>
      <div className="ks-row"><div className="ks-l"><b>{t("This device")}</b><span>{data.deviceName || <Missing kind="nodata" />}</span><span className="z-mono">{data.linkedAt ? t("linked {{date}}", { date: formatSeen(data.linkedAt) }) : <Missing kind="nodata" />}</span></div><button className="ks-link" type="button" disabled={!onDevices} title={onDevices ? undefined : t("No account of its own")} onClick={onDevices}>{t("View devices")}</button></div>
      <div className="ks-row"><div className="ks-l"><b>{t("Last used")}</b><span className="z-mono">{data.lastUsed ? formatSeen(data.lastUsed) : <Missing kind="nodata" />}</span></div></div>
      <div className="ks-row"><div className="ks-l"><b>{t("Status")}</b><Word tone={data.state === 'activa' ? 'ok' : data.state === 'rechazada' ? 'bad' : 'warn'} title={data.reason ?? undefined}>{states[data.state]}</Word></div><button className="ks-link" type="button" onClick={onSignOut}>{t("Sign out")}</button></div>
    </div> : null}
  </section>
}
