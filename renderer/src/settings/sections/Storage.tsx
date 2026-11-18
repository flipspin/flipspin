import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { bridge } from '../../bridge'
import { apiGet } from '../../data'
import { confirmAction } from '../../ui/confirm'
import { Missing } from '../../ui/react/components/Missing'
import { changeOfflineTrack, OFFLINE_REASONS, offlineReason, useOfflineStorage } from '../../offline/useOfflineStorage'
import { formatBytes } from '../format'
import { Switch } from '../parts'
import { Page } from './Head'
import './storage.css'

export function Storage(): React.JSX.Element {
  const { t } = useTranslation()
  const { data, error, refresh } = useOfflineStorage()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setFailure(null)
    try { await action(); await refresh() }
    catch (error) { setFailure(error instanceof Error && OFFLINE_REASONS[error.message] ? OFFLINE_REASONS[error.message] : t("Could not complete the action. Try again.")) }
    finally { setBusy(false) }
  }
  const pins = data?.pools.pins
  const libraryPins = pins?.filter(pin => pin.kind === 'library') ?? []
  const automatic = async (enabled: boolean) => {
    if (!enabled) {
      for (const pin of libraryPins) await bridge().invoke('offline:unpin', { pinId: pin.id })
      return
    }
    const library = await apiGet('/api/me/library')
    const result = await bridge().invoke('offline:pin', {
      kind: 'library', ref: 'library', tracks: library.tracks.map(track => ({ key: track.relPath, inLibrary: true })),
    })
    if (result.ok === false) throw new Error(result.reason)
  }
  const removeAll = () => run(async () => {
    if (await confirmAction({ title: t("Remove all downloads?"), message: t("Songs stay in your library and on the nest."), confirmLabel: t("Remove all downloads"), destructive: true })) {
      await bridge().invoke('offline:pools', { action: 'remove-downloads' })
    }
  })
  const tracks = data?.status.tracks.filter(track => track.pool === 'offline') ?? []
  const downloading = tracks.some(track => track.state === 'descargando' || track.state === 'en fila' || track.state === 'desactualizado')
  const failed = tracks.filter(track => track.state === 'fallido' || track.state === 'ya no está en el nido')
  const unavailable = <Missing kind={error ? 'unavailable' : 'loading'} />
  return <Page id="almacenamiento">
    <div className="storage" aria-busy={busy}>
      <dl className="storage-list">
        <div><dt title={t("Verified files in this computer’s download store")}>{t("Downloads")}</dt><dd>
          {data ? <><span className="storage-number">{t("{{n}} songs", { count: data.pools.offline.files, n: data.pools.offline.files })} · {formatBytes(data.pools.offline.bytes)}</span><span className="storage-status" data-tone={downloading ? 'blue' : 'green'}><i />{downloading ? t("Downloading") : t("Up to date_current")}</span></> : unavailable}
        </dd></div>
        <div><dt title={t("Cache files and budget calculated by this computer")}>{t("Cache")}</dt><dd>
          {data ? <><span className="storage-cache"><span className="storage-number">{t("{{used}} of {{total}}", { used: formatBytes(data.pools.cache.bytes), total: formatBytes(data.pools.cacheBudget) })}</span><meter min={0} max={Math.max(1, data.pools.cacheBudget)} value={data.pools.cache.bytes} aria-label={t("Cache")} /></span><button className="storage-button" type="button" disabled={busy || !data.pools.cache.bytes} title={t("Songs will be cached again when you listen to them")} onClick={() => void run(() => bridge().invoke('offline:pools', { action: 'clear-cache' }))}>{t("Clear cache")}</button></> : unavailable}
        </dd></div>
        <div><dt>{t("Location_location")}</dt><dd>{data ? <code className="storage-path" title={data.pools.offline.location}>{data.pools.offline.location}</code> : unavailable}</dd></div>
        <div><dt>{t("Automatic downloads")}</dt><dd><Switch label={t("Automatic downloads")} title={t("Download my entire library to this computer")} checked={libraryPins.length > 0} disabled={busy || !pins} onChange={next => void run(() => automatic(next))} /></dd></div>
      </dl>
      {failed.length ? <section aria-label={t("Failed downloads")}>
        <h3>{t("{{n}} downloads failed", { n: failed.length, count: failed.length })}</h3>
        <dl className="storage-list storage-failures">{failed.map(track => <div key={track.key}>
          <dt title={track.key}>{track.key.split('/').pop()}</dt><dd>
            <span className="storage-status" data-tone="rose" title={track.error ?? undefined}><i />{t(offlineReason(track))}</span>
            <span className="storage-actions">
              {track.state !== 'ya no está en el nido' ? <button className="storage-link" type="button" disabled={busy || !pins} onClick={() => void run(() => changeOfflineTrack(data!.pools, track.key, false))}>{t("Retry")}</button> : null}
              <button className="storage-link" type="button" disabled={busy || !pins} onClick={() => void run(() => changeOfflineTrack(data!.pools, track.key, true))}>{t("Delete")}</button>
            </span>
          </dd>
        </div>)}</dl>
      </section> : null}
      {error ? <div role="alert" className="storage-error">{t("Could not read storage")} <button className="storage-link" type="button" onClick={() => void refresh()}>{t("Retry")}</button></div> : null}
      {failure ? <div role="alert" className="storage-error">{t(failure)}</div> : null}
      <button type="button" className="storage-danger" disabled={busy || !data || !data.status.pins} onClick={() => void removeAll()}>{t("Remove all downloads")}</button>
    </div>
  </Page>
}
