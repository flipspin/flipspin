import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Missing } from '../../ui/react/components/Missing'
import { isApiError, serverDetail } from '../../data'
import { useExportKey, useSecrets } from '../../data/hooks/use-secrets'
import { useSettings } from '../context'
import { Modal, QueryFailure, Skel, useToast } from '../parts'

function ExportKey({ fingerprint, close }: { fingerprint: string; close: () => void }) {
  const { t } = useTranslation()
  const toast = useToast()
  const exportKey = useExportKey()
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  async function submit() {
    setProblem(null)
    try {
      if (await exportKey.mutateAsync({ password, fingerprint })) toast(t("Key downloaded"))
      close()
    } catch (error) {
      const detail = isApiError(error) ? serverDetail(error) : null
      setProblem(detail === 'account-password-required' ? t("This session has no account with a password")
        : detail === 'llave-distinta' ? t("The nest key is unreadable")
          : isApiError(error) && error.status === 401 ? t("The password is incorrect")
            : isApiError(error) && error.status === 429 ? t("Wait before trying again") : t("Could not download the key"))
    } finally {
      setPassword('')
      exportKey.reset()
    }
  }
  return <Modal title={t("Download key")} busy={exportKey.isPending} onClose={() => { if (!exportKey.isPending) close() }}>
    <form onSubmit={event => { event.preventDefault(); if (password && !exportKey.isPending) void submit() }}>
      <label className="z-field"><span className="z-label">{t("Password")}</span><input className="ks-field" type="password" autoComplete="current-password" maxLength={256} value={password} disabled={exportKey.isPending} onChange={event => setPassword(event.target.value)} /></label>
      {problem ? <span className="z-err" role="alert">{problem}</span> : null}
      <div className="settings-modal__do"><button className="ks-btn" type="button" disabled={exportKey.isPending} onClick={close}>{t("Cancel")}</button><button className="ks-btn ks-btn--go" type="submit" disabled={!password || exportKey.isPending}>{t("Download key")}</button></div>
    </form>
  </Modal>
}

export function NestKey() {
  const { t } = useTranslation()
  const { server } = useSettings()
  const query = useSecrets()
  const [exporting, setExporting] = useState(false)
  const data = query.data
  const localKeychain = data?.key.source === 'credentials-dir' && server.kind === 'ready' && server.value?.mode === 'child' && server.value.ownedByUs
  const location = localKeychain ? t("This computer’s keychain") : data?.key.source === 'credentials-dir' ? t("System credential") : data?.key.source === 'key-file' ? t("Key file") : t("Generated in the nest")
  return <section className="settings-block ks-group" aria-label={t("Nest key")}>
    <div className="settings-block__head"><h3 title={t("Encrypts source keys and app passwords. Without it, they must be entered again")}>{t("Nest key")}</h3></div>
    {query.isPending ? <Skel rows={3} /> : query.isError ? <QueryFailure error={query.error} what={t("the nest key")} onRetry={() => void query.refetch()} /> : <div className="settings-block__body">
      <div className="ks-row"><div className="ks-l"><b>{t("Location_lives")}</b><span title={localKeychain ? t("The system keychain provides it to the nest at startup; it is never stored in a file") : data?.key.source === 'credentials-dir' ? 'CREDENTIALS_DIRECTORY' : data?.key.source === 'key-file' ? 'KROBI_SECRET_KEY_FILE' : 'credentials/.key'}>{location}</span></div></div>
      <div className="ks-row"><div className="ks-l"><b>{t("Fingerprint")}</b>{data?.key.fingerprint ? <span className="z-mono">{data.key.fingerprint}</span> : <Missing kind="nodata" />}</div><button className="ks-btn ks-btn--sm" type="button" disabled={!data?.key.fingerprint} title={t("Keep it outside the nest: if the nest is reinstalled without it, keys must be entered again")} onClick={() => setExporting(true)}>{t("Download key")}</button></div>
      <div className="ks-row"><div className="ks-l"><b>{t("Keys it encrypts")}</b><span className="z-mono">{data?.counts ? <>{t("{{n}} source keys", { n: data.counts.sources })} · {data.counts.appPasswords === null ? <Missing kind="nodata" /> : t("{{n}} app passwords", { n: data.counts.appPasswords })}</> : <Missing kind="nodata" />}</span></div></div>
    </div>}
    {exporting && data?.key.fingerprint ? <ExportKey fingerprint={data.key.fingerprint} close={() => setExporting(false)} /> : null}
  </section>
}
