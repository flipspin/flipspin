import { useState } from 'react'
import { RotateCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { bridge } from '../bridge'
import type { OutboxIntent } from '../lib/ipc'
import { useOutbox } from './useOffline'

type Version = { tracks?: { title?: string; path?: string }[] }
function versions(row: OutboxIntent): { local: Version; remote: Version } | null {
  if (!row.lastError?.startsWith('412:')) return null
  try {
    return { local: JSON.parse(row.body) as Version, remote: (JSON.parse(row.lastError.slice(4)) as { detail: { current: Version } }).detail.current }
  } catch { return null }
}
export function OutboxJobs() {
  const { t } = useTranslation()
  const rows = useOutbox()
  if (!rows.length) return null
  return <section aria-label={t("Pending changes")}>
    <div className="px-3 pt-3 pb-1 border-t border-[var(--line-soft)] text-[11px] font-bold uppercase tracking-wide text-[var(--ink-3)]">
      {t("{{n}} changes are waiting for the nest", { n: rows.length })}
    </div>
    {rows.map(row => <OutboxRow key={row.id} row={row} />)}
  </section>
}

function OutboxRow({ row }: { row: OutboxIntent }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const conflict = versions(row)
  const label = row.intent === 'playlist-edit' ? t("Edit playlist") : row.intent === 'library-add' ? t("Add to my library") : t("Remove from my library")
  const run = async (action: 'retry' | 'discard') => {
    setBusy(true); setError(false)
    try { await bridge().invoke('offline:outbox', { action, id: row.id }) } catch { setError(true) } finally { setBusy(false) }
  }
  return <article className="work-row" aria-label={label}>
    <div className="work-title"><span className="work-mark" data-tone={row.lastError ? 'rose' : 'blue'} aria-hidden="true"><i /></span><b>{label}</b></div>
    <div className="work-failure">
      {row.lastError ? <span role="status" className="work-reason"><i />{conflict ? t("Changed on the nest") : row.lastError}</span> : null}
      {row.state === 'failed' && !conflict ? <button type="button" className="work-action" disabled={busy} onClick={() => void run('retry')}><RotateCw size={13} strokeWidth={2.5} aria-hidden="true" />{t("Retry")}</button> : null}
      <button type="button" className="work-action" disabled={busy} onClick={() => void run('discard')}>{t("Discard")}</button>
    </div>
    {conflict ? <details className="ml-[30px] mt-2 text-[12px]"><summary className="work-action">{t("View both versions")}</summary>
      {([[t("On this computer_device"), conflict.local], [t("In the nest"), conflict.remote]] as const).map(([name, version]) => <div key={name} className="mt-2"><b>{name}</b><ol>{version.tracks?.map((track, index) => <li key={index}>{track.title || track.path}</li>)}</ol></div>)}
    </details> : null}
    {error ? <p role="alert" className="work-error">{t("Could not complete the action. Try again.")}</p> : null}
  </article>
}
