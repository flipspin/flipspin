import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { apiPost, queryKeys } from '../../data'
import { ErrorAlt, OldNest, Skel } from '../parts'
import { isOlderNest } from '../data'
import { Missing } from '../../ui/react/components/Missing'

import { libraryScanKey, useLibraryScan } from '../libraryScansData'
import { LibraryCheckInterval } from '../LibraryWatch'

export function LibraryScans(): React.JSX.Element {
  return <LibraryScanControls scan={useLibraryScan()} />
}

export function LibraryScanControls({ scan }: { scan: ReturnType<typeof useLibraryScan> }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const client = useQueryClient()
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const last = useRef<string | null | undefined>(undefined)
  const completed = scan.data?.lastScanAt
  useEffect(() => {
    if (completed !== undefined) {
      if (completed && last.current !== undefined && completed !== last.current) {
        void client.invalidateQueries({ queryKey: queryKeys.library.all })
      }
      last.current = completed
    }
  }, [client, completed])
  const start = async (full: boolean) => {
    setSending(true)
    setFailed(false)
    try {
      client.setQueryData(libraryScanKey, await apiPost('/api/library/scan', { body: { full } }))
      await scan.refetch()
    } catch {
      setFailed(true)
    } finally {
      setSending(false)
    }
  }
  if (scan.isPending) return <Skel rows={1} label={t("Loading scan status")} />
  if (scan.isError) return isOlderNest(scan.error)
    ? <OldNest>{t("Update the nest to scan the library.")}</OldNest>
    : <ErrorAlt what={t("scan status")} onRetry={() => void scan.refetch()} />
  const data = scan.data
  const busy = sending || data.scanning || data.pending
  const when = data.lastScanAt ? new Date(data.lastScanAt).toLocaleString(i18n.language) : null
  const duration = data.durationSeconds === null ? null : new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(data.durationSeconds)
  return <>
    <div className="ks-row" aria-live="polite">
      <div className="ks-l">
        <b>{busy ? t("Scanning…") : t("Last scan")}</b>
        <span>{when ? <time dateTime={data.lastScanAt ?? undefined}>{when}</time> : <Missing kind="never" />}{duration !== null ? ` · ${t('{{n}} s', { n: duration })}` : null}</span>
        <span>{data.watching ? `${t('Watching for changes')} · ` : null}<LibraryCheckInterval seconds={data.intervalSeconds} watching={data.watching} /></span>
        {data.error ? <span role="alert">{data.error === 'empty' || data.error === 'unavailable' ? t("Folder unavailable") : t("Scan failed")}</span> : null}
      </div>
      <div className="settings-scan-actions">
        <button className="ks-btn" type="button" disabled={busy} onClick={() => void start(false)}>{t("Scan for changes")}</button>
        <button className="ks-btn" type="button" disabled={busy} onClick={() => void start(true)}>{t("Full rescan")}</button>
      </div>
    </div>
    {failed ? <div role="alert" className="settings-alt"><span>{t("Could not start the scan")}</span><button className="ks-btn" type="button" onClick={() => setFailed(false)}>{t("Close")}</button></div> : null}
  </>
}
