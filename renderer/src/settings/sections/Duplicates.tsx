import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { apiPost, apiPut, isApiError } from '../../data'
import { Missing } from '../../ui/react/components/Missing'
import { useSettings } from '../context'
import { isOlderNest } from '../data'
import { duplicatesKey, useDuplicates, type DuplicateGroup, type DuplicateList } from '../duplicatesData'
import { ErrorAlt, OldNest, Skel } from '../parts'
import { Page } from './Head'
import './duplicates.css'

function length(seconds: number): string {
  const value = Math.round(Math.abs(seconds))
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`
}
function signed(value: number): string {
  return `${value < 0 ? '−' : '+'}${Math.abs(value).toLocaleString('en')}`
}

function DuplicateCard({ group, disabled, save, dismiss }: {
  group: DuplicateGroup
  disabled: boolean
  save: (keep: string) => Promise<boolean>
  dismiss: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [choosing, setChoosing] = useState(false)
  const [selected, setSelected] = useState(group.keeper)
  const heading = `duplicate-${group.groupId}`
  return <section className="du-group" aria-labelledby={heading}>
    <div className="du-heading">
      <h3 id={heading}>{group.title || t("Untitled")}{group.artist ? <span> · {group.artist}</span> : null}</h3>
      <span className="du-basis" data-basis={group.basis}>{group.basis === 'audio' ? t("Same audio") : t("Same tags")}</span>
      <span className="du-count">{t("{{count}} copies", { count: group.files.length })}</span>
    </div>
    <div className="du-scroll" role="region" aria-label={t("Copies of {{title}}", { title: group.title || t("Untitled") })} tabIndex={0}>
      <table className="du-table">
        <thead><tr><th scope="col">{t("Preference")}</th><th scope="col">{t("File")}</th><th scope="col">{t("Format")}</th><th scope="col">{t('Bitrate')}</th><th scope="col">{t("Length")}</th><th scope="col">{t("Plays")}</th></tr></thead>
        <tbody>{group.files.map(file => {
          const keeper = file.relPath === group.keeper
          return <tr key={file.relPath} data-keeper={keeper} data-missing={file.missing}>
            <td>{choosing ? <label className="du-choice"><input type="radio" name={`keeper-${group.groupId}`} checked={selected === file.relPath} disabled={disabled || file.missing} onChange={() => setSelected(file.relPath)} aria-label={t("Keep {{file}}", { file: file.relPath })} />{keeper ? t("Keep") : t("Copy_imperative")}</label> : <span className={keeper ? 'du-keep' : 'du-copy'}>{keeper ? t("Keep") : t("Copy_imperative")}</span>}</td>
            <td className="du-file">{file.relPath}{file.missing ? <span className="du-unavailable">{t("Unavailable")}</span> : null}</td>
            <td data-different={!keeper && file.difference.format}>{file.format}</td>
            <td>{file.bitrate === null ? <Missing kind="unmeasured" /> : <>{file.bitrate.toLocaleString('en')} <small>{t("kbps")}</small></>}{!keeper && file.difference.bitrate ? <span className="du-difference">{signed(file.difference.bitrate)}</span> : null}</td>
            <td>{file.duration === null ? <Missing kind="unmeasured" /> : length(file.duration)}{!keeper && file.difference.duration ? <span className="du-difference">{file.difference.duration < 0 ? '−' : '+'}{length(file.difference.duration)}</span> : null}</td>
            <td>{file.plays.toLocaleString('en')}{!keeper && file.difference.plays ? <span className="du-difference">{signed(file.difference.plays)}</span> : null}</td>
          </tr>
        })}</tbody>
      </table>
    </div>
    <div className="du-actions">{choosing ? <>
      <button className="ks-btn" type="button" disabled={disabled || selected === group.keeper} onClick={() => void save(selected).then(ok => { if (ok) setChoosing(false) })}>{t("Save preference")}</button>
      <button className="ks-btn" type="button" disabled={disabled} onClick={() => setChoosing(false)}>{t("Cancel")}</button>
    </> : <button className="ks-btn" type="button" disabled={disabled} onClick={() => { setSelected(group.keeper); setChoosing(true) }}>{t("Choose another to keep")}</button>}
      <button className="ks-btn" type="button" disabled={disabled} onClick={dismiss}>{t("Not duplicates")}</button>
    </div>
  </section>
}

export function Duplicates(): React.JSX.Element {
  const { t } = useTranslation()
  const { go } = useSettings()
  return <Page id="duplicates" before={<div className="cx-crumb"><button className="ks-link" type="button" onClick={() => go('biblioteca')}>{t("Library")}</button><span>›</span></div>}><DuplicateResults /></Page>
}

export function DuplicateResults(): React.JSX.Element {
  const { t } = useTranslation()
  const query = useDuplicates()
  const client = useQueryClient()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const command = async (action: () => Promise<DuplicateList>) => {
    setSending(true)
    setError(null)
    await client.cancelQueries({ queryKey: duplicatesKey })
    try {
      client.setQueryData(duplicatesKey, await action())
      return true
    } catch (error) {
      setError(isApiError(error) && error.status === 409 ? t("Group changed. Scan for duplicates again.") : t("Couldn't save preference"))
      void query.refetch()
      return false
    } finally {
      setSending(false)
    }
  }
  const start = async () => {
    setSending(true)
    setError(null)
    try {
      const job = await apiPost('/api/library/duplicates/scan')
      client.setQueryData<DuplicateList>(duplicatesKey, current => current ? { ...current, jobId: job.jobId, state: 'queued' } : current)
      await query.refetch()
    } catch {
      setError(t("Couldn't start duplicate scan"))
    } finally {
      setSending(false)
    }
  }
  if (query.isPending) return <Skel rows={3} label={t("Loading duplicates")} />
  if (query.isError) return isOlderNest(query.error) ? <OldNest>{t("Update the nest to find duplicates.")}</OldNest> : <ErrorAlt what={t("duplicates")} onRetry={() => void query.refetch()} />
  const data = query.data
  const scanning = ['queued', 'running'].includes(data.state)
  const busy = sending || scanning
  return <div className="du-results">
    <div className="du-toolbar">
      <span role="status">{scanning ? t("Finding duplicates…") : data.state === 'idle' ? t("Not checked_unreviewed") : t("{{count}} groups", { count: data.groups.length })}</span>
      <button className="ks-btn" type="button" disabled={busy} onClick={() => void start()}>{t("Find duplicates")}</button>
    </div>
    {data.audio === 'unavailable' ? <p className="du-status">{t("Same audio skipped · fpcalc unavailable on the nest")}</p> : null}
    {data.audioSkipped > 0 ? <p className="du-status">{t("{{count}} files without audio fingerprints", { count: data.audioSkipped })}</p> : null}
    {['failed', 'interrupted', 'cancelled'].includes(data.state) ? <p role="alert">{t("Duplicate scan didn't finish")}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {!busy && data.state === 'succeeded' && !data.groups.length ? <p className="du-empty">{t("No possible duplicates")}</p> : null}
    {data.groups.map(group => <DuplicateCard key={group.groupId} group={group} disabled={busy}
      save={keep => command(() => apiPut('/api/library/duplicates/{groupId}/keeper', { params: { path: { groupId: group.groupId } }, body: { keep } }))}
      dismiss={() => void command(() => apiPost('/api/library/duplicates/{groupId}/dismiss', { params: { path: { groupId: group.groupId } } }))} />)}
  </div>
}
