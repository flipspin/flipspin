import { useSplits } from '../../stems/useStemSong'
import { stemPlayer } from '../../stems/StemPlayer'
import { useState } from 'react'
import { Search, X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { apiDelete, queryKeys, type ApiData } from '../../data'
import { Modal, QueryFailure, Skel, Switch, useToast } from '../parts'
import { formatBytes, formatCount } from '../format'
import { splitKey, useSplitDeletes, type Split } from '../splitDeletes'
import { Page } from './Head'
import { useSettings } from '../context'
import { useCompute, useComputeActions } from '../background/data'
import { RunsOn } from '../background/RunsOn'
import { Missing } from '../../ui/react/components/Missing'

function SplitDate({ value }: { value: string | null }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const date = value ? new Date(value) : null
  const valid = date && Number.isFinite(date.getTime())
  const today = valid && date.toDateString() === new Date().toDateString()
  const parts = valid ? new Intl.DateTimeFormat(i18n.language.startsWith('es') ? 'es-MX' : i18n.language, { day: 'numeric', month: 'short' }).formatToParts(date) : []
  // The approved Spanish date has no “de” separator or month period.
  const word = i18n.language.startsWith('es') ? ['day', 'month'].map(type => parts.find(p => p.type === type)?.value.replace(/\.$/, '')).join(' ') : parts.map(p => p.value).join('')
  return <time className="settings-stems__date" dateTime={valid ? date.toISOString() : undefined} title={valid ? date.toLocaleString(i18n.language) : undefined}>{today ? t("today") : valid ? word : <Missing kind="nodata" />}</time>
}

export function StemSeparation(): React.JSX.Element {
  const { t } = useTranslation()
  const { admin } = useSettings()
  const compute = useCompute(admin === true)
  const actions = useComputeActions()
  const kind = compute.data?.kinds.find(k => k.kind === 'stems')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [confirmAll, setConfirmAll] = useState(false)
  const toast = useToast()
  const client = useQueryClient()
  const { hidden, hide } = useSplitDeletes()
  const query = useSplits(admin === true)
  const splits = query.data?.splits.filter(split => !hidden.has(splitKey(split))) ?? []
  const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim()
  const term = normalize(search)
  const songs = splits.filter(split => normalize(`${split.title} ${split.artist} ${split.albumTitle}`).includes(term))
    .sort((a, b) => (Date.parse(b.createdAt ?? '') || 0) - (Date.parse(a.createdAt ?? '') || 0))
  const pages = Math.max(1, Math.ceil(songs.length / 6))
  const current = Math.min(page, pages)
  const start = (current - 1) * 6
  const visible = songs.slice(start, start + 6)
  const pageNumbers = Array.from(new Set([1, ...Array.from({ length: 3 }, (_, i) => Math.max(1, Math.min(current - 1, pages - 2)) + i), pages])).filter(n => n <= pages)
  const totalSize = query.data ? formatBytes(splits.reduce((total, split) => total + split.sizeBytes, 0)) : null

  function remove(split?: Split) {
    const targets = split ? [split] : query.data?.splits ?? []
    // A replacement toast cancels the previous pending operation first.
    let release = () => {}
    toast(split ? t("{{title}} · stems deleted_stems", { title: split.title }) : t("All stems deleted"), {
      undo: () => release(),
      onDismiss: () => release(),
      onExpire: () => { void commit() },
    })
    release = hide(targets)
    async function commit() {
      try {
        if (split) await apiDelete('/api/stems/{album}/{file}', { params: { path: { album: split.album, file: split.file } } })
        else await apiDelete('/api/stems')
        targets.forEach(target => stemPlayer.refresh(target, true))
        const removed = new Set(targets.map(splitKey))
        client.setQueryData<ApiData<'/api/stems', 'get'>>(queryKeys.stems.splits(), data => data ? { splits: data.splits.filter(s => !removed.has(splitKey(s))) } : data)
        await client.invalidateQueries({ queryKey: queryKeys.stems.all })
        void client.invalidateQueries({ queryKey: queryKeys.server.storage() })
      } catch {
        toast(t("Could not delete the stems. Try again._stems"), { err: true })
      } finally { release() }
    }
  }

  return <Page id="stems">
    <section className="settings-block ks-group">
      <div className="ks-row"><span className="ks-l"><b>{t("Separate automatically")}</b><span>{kind ? t("{{n}} waiting", { n: kind.waiting }) : <Missing kind={compute.isError ? 'nodata' : 'loading'} />}</span></span><Switch label={t("Separate automatically")} checked={kind?.policy.libraryPass === 'auto'} disabled={!kind || actions.busy} onChange={value => void actions.kind('stems', { libraryPass: value ? 'auto' : 'ask' })} /></div>
      <RunsOn kind="stems" />
    </section>
    <section className="settings-block ks-group cx-stems" aria-label={t("Songs with stems")}>
      <div className="settings-block__head"><h3>{t("Songs with stems")}</h3><span className="settings-count">{query.data ? `${formatCount(splits.length)} · ${totalSize}` : <Missing kind="loading" />}</span>
        {splits.length ? <button type="button" className="ks-link ks-btn--danger settings-head-act" title={t("Delete stems; keep the songs")} onClick={() => setConfirmAll(true)}>{t("Delete all")}</button> : null}
      </div>
      <div className="cx-search"><Search aria-hidden /><input type="search" aria-label={t("Search song, artist or album")} placeholder={t("Search song, artist or album")} value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} /><code aria-live="polite">{query.data ? t("{{count}} songs", { count: songs.length }) : <Missing kind="loading" />}</code></div>
      <div className="cx-tbl" role="table" aria-label={t("Songs with stems")} aria-colcount={6}>
        <div className="cx-tr cx-th" role="row"><span role="columnheader">{t("Song")}</span><span role="columnheader" className="cx-detail">{t("Artist")}</span><span role="columnheader" className="cx-detail">{t("Album")}</span><span role="columnheader" className="sorted" aria-sort="descending">{t("Separated")}</span><span role="columnheader" className="num">{t("Size")}</span><span role="columnheader" aria-label={t("Actions")} /></div>
        <div className="cx-body" role="rowgroup" style={{ height: 228 }}>
          {!query.data && query.isPending ? <Skel rows={6} /> : !query.data && query.isError ? <QueryFailure error={query.error} what={t("stems")} onRetry={() => void query.refetch()} /> : query.data ? <>
            {visible.map(split => <div className="cx-tr" role="row" key={splitKey(split)}>
              <span role="cell" title={[split.title, split.artist, split.albumTitle].filter(Boolean).join(' · ')}>{split.title}</span>
              <span role="cell" className="mute cx-detail" title={split.artist}>{split.artist || <Missing kind="noArtist" />}</span>
              <span role="cell" className="mute cx-detail" title={split.albumTitle}>{split.albumTitle || <Missing kind="noAlbum" />}</span>
              <span role="cell" className="mute"><SplitDate value={split.createdAt} /></span>
              <span role="cell" className="num">{formatBytes(split.sizeBytes)}</span>
              <span role="cell" className="act"><button type="button" className="ks-btn ks-btn--ghost ks-btn--icon" aria-label={t("Delete stems for {{title}}", { title: split.title })} title={t("Delete the stems; keep the song")} onClick={() => remove(split)}><X className="i" aria-hidden /></button></span>
            </div>)}
            {!songs.length ? <div className="settings-stems__empty">{splits.length ? <>{t("No songs match.")} <button type="button" className="ks-link" onClick={() => { setSearch(''); setPage(1) }}>{t("Clear search")}</button></> : t("None yet")}</div> : null}
          </> : null}
        </div>
      </div>
      <nav className="cx-foot" aria-label={t("Songs with stems pages")}>
        <code>{query.data ? t("{{from}}–{{to}} of {{total}}", { from: songs.length ? start + 1 : 0, to: start + visible.length, total: songs.length }) : <Missing kind="loading" />}</code>
        <button className="cx-pg" type="button" aria-label={t("Previous")} disabled={current === 1} onClick={() => setPage(current - 1)}>‹</button>
        {pageNumbers.map((n, i) => <span className="cx-page-number" key={n}>{i > 0 && n > pageNumbers[i - 1] + 1 ? <span aria-hidden>…</span> : null}<button className="cx-pg" type="button" aria-label={t("Page {{page}}", { page: n })} aria-current={n === current ? 'page' : undefined} onClick={() => setPage(n)}>{n}</button></span>)}
        <button className="cx-pg" type="button" aria-label={t("Next")} disabled={current === pages} onClick={() => setPage(current + 1)}>›</button>
      </nav>
    </section>
    {confirmAll ? <Modal title={t("Delete all stems")} onClose={() => setConfirmAll(false)}>
      <p>{t("Stems for {{count}} songs will be deleted. The songs stay.", { count: splits.length })}</p>
      <div className="settings-modal__do"><button type="button" className="ks-btn ks-btn--ghost" onClick={() => setConfirmAll(false)}>{t("Cancel")}</button><button type="button" className="ks-btn ks-btn--danger" onClick={() => { setConfirmAll(false); remove() }}>{t("Delete all")}</button></div>
    </Modal> : null}
  </Page>
}
