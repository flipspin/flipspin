/** A bounded song picker; selection belongs to track identity, never row order. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Search, X } from 'lucide-react'
import { fetchPendingSongs, transcribe } from '../../lyrics/lyricsStore'
import { keysForPath } from '../../library/libraryKeys'
import { useLibraryAlbums } from '../../data'
import { useLibrarySummary } from '../data'
import { formatCount } from '../format'
import { helperSpeed, type Helper } from '../helper'
import { Empty, ErrorAlt, Modal, Skel, useToast } from '../parts'
import { Missing } from '../../ui/react/components/Missing'

const PAGE_SIZE = 8
type Sort = 'title' | 'artist' | 'album' | 'duration'

export function Transcribe({ helper, computer, available, onClose }: {
  helper: Helper | null
  computer: string
  available: boolean
  onClose: () => void
}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const toast = useToast()
  const [data, setData] = useState<Awaited<ReturnType<typeof fetchPendingSongs>> | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [sort, setSort] = useState<Sort>('artist')
  const [descending, setDescending] = useState(false)
  const [page, setPage] = useState(1)
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState(false)
  const pageCheckbox = useRef<HTMLInputElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const library = useLibraryAlbums()
  const summary = useLibrarySummary()

  useEffect(() => {
    let alive = true
    setFailed(false)
    fetchPendingSongs().then(value => { if (alive) setData(value) }, () => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [attempt])

  const durations = useMemo(() => {
    const values = new Map<string, number>()
    for (const album of library.data ?? []) for (const track of album.tracks) {
      const keys = keysForPath(track.path, summary.data?.folder)
      const rel = track.relPath || (keys ? `${keys.album}/${keys.file}` : null)
      if (rel && Number.isFinite(track.duration) && track.duration > 0) values.set(rel, track.duration)
    }
    return values
  }, [library.data, summary.data?.folder])

  const shown = useMemo(() => {
    const search = query.trim().toLocaleLowerCase(i18n.language)
    const collator = new Intl.Collator(i18n.language, { numeric: true, sensitivity: 'base' })
    return (data?.songs ?? []).filter(song => !search || [song.title, song.artist, song.album].some(value => value.toLocaleLowerCase(i18n.language).includes(search))).sort((a, b) => {
      let order: number
      if (sort === 'duration') {
        const ad = durations.get(a.relPath), bd = durations.get(b.relPath)
        // Unknown durations stay last in either direction.
        if (ad === undefined || bd === undefined) return ad === bd ? collator.compare(a.relPath, b.relPath) : ad === undefined ? 1 : -1
        order = ad - bd
      } else order = collator.compare(a[sort], b[sort])
      return (order || collator.compare(a.relPath, b.relPath)) * (descending ? -1 : 1)
    })
  }, [data, query, sort, descending, durations, i18n.language])
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  const current = Math.min(page, pages)
  const rows = shown.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)
  const picked = (data?.songs ?? []).filter(song => selected.has(song.relPath))
  const allPage = rows.length > 0 && rows.every(song => selected.has(song.relPath))
  const somePage = rows.some(song => selected.has(song.relPath))
  useEffect(() => { if (pageCheckbox.current) pageCheckbox.current.indeterminate = somePage && !allPage }, [somePage, allPage])
  useEffect(() => { viewport.current?.scrollTo?.(0, 0) }, [current, query, sort, descending])

  const speed = helperSpeed(helper, 'transcribe')
  const missingDuration = picked.some(song => !durations.has(song.relPath))
  const seconds = picked.reduce((total, song) => total + (durations.get(song.relPath) ?? 0), 0)
  const minutes = speed.value !== null && !missingDuration ? Math.ceil(seconds * speed.value / 3600) : null
  const estimateTip = speed.value === null ? t(helper ? speed.reason : "Not measured yet") : missingDuration ? t("A selected song is missing its duration.") : t("Calculated using {{n}} s/min, measured on {{name}}", { n: speed.value.toLocaleString(i18n.language, { maximumFractionDigits: 1 }), name: computer })
  const close = () => { if (!busy) onClose() }
  const toggle = (paths: string[], on: boolean) => setSelected(previous => {
    const next = new Set(previous)
    for (const path of paths) { if (on) next.add(path); else next.delete(path) }
    return next
  })
  const submit = async () => {
    if (busy || !available || !picked.length) return
    setBusy(true)
    setSubmitError(false)
    try {
      await transcribe(picked.map(song => ({ relPath: song.relPath })))
      toast(t("Transcription queued"))
      onClose()
    } catch { setSubmitError(true) }
    finally { setBusy(false) }
  }
  const headings: { key: Sort; label: string }[] = [
    { key: 'title', label: t("Song") }, { key: 'artist', label: t("Artist") },
    { key: 'album', label: t("Album") }, { key: 'duration', label: t("Duration") },
  ]
  // Neighbouring pages plus both ends, bounded even for very large libraries.
  const pageNumbers = [...new Set([1, current - 1, current, current + 1, pages])].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b)

  return <Modal title={t("Transcribe lyrics")} onClose={close} busy={busy} className="cx-transcribe" heading={id => <div className="cx-modal-head"><h3 id={id}>{t("Transcribe lyrics")}</h3><button className="ks-btn ks-btn--ghost" type="button" aria-label={t("Close")} disabled={busy} onClick={close}><X aria-hidden /></button></div>}>
    <div className="cx-search"><Search aria-hidden /><input type="search" aria-label={t("Search the pending ones")} placeholder={t("Search song, artist or album")} value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} /><code aria-live="polite">{data ? t("{{n}} without lyrics", { n: formatCount(shown.length) }) : '…'}</code></div>
    <div className="cx-sel">{t("Selected {{n}} of {{total}}", { n: formatCount(picked.length), total: data ? formatCount(data.songs.length) : '…' })} · <button className="ks-link" type="button" disabled={!shown.length || busy} onClick={() => toggle(shown.map(song => song.relPath), true)}>{t("Select all {{n}}", { count: shown.length, n: formatCount(shown.length) })}</button>{data && !data.complete ? <span title={t("Update the nest to see all pending songs.")}> · {t("Partial view")}</span> : null}</div>
    <div className="cx-table-viewport" ref={viewport}>
      <div className="cx-tbl" role="table" aria-label={t("Songs without lyrics")} aria-busy={!data && !failed}>
        <div className="cx-tr cx-th" role="row"><span role="columnheader" className="ck"><input ref={pageCheckbox} type="checkbox" aria-label={t("Select this page")} checked={allPage} disabled={!rows.length || busy} onChange={event => toggle(rows.map(song => song.relPath), event.target.checked)} /></span>{headings.map(({ key, label }) => <span key={key} role="columnheader" className={key === 'duration' ? 'num' : undefined} aria-sort={sort === key ? descending ? 'descending' : 'ascending' : 'none'}><button className="cx-sort" type="button" onClick={() => { if (sort === key) setDescending(value => !value); else { setSort(key); setDescending(false) } setPage(1) }}>{label}{sort === key ? <span aria-hidden>{descending ? ' ↓' : ' ↑'}</span> : null}</button></span>)}</div>
        <div className="cx-body" role="rowgroup">
          {failed ? <ErrorAlt what={t("the songs without lyrics")} onRetry={() => setAttempt(value => value + 1)} /> : !data ? <Skel rows={8} /> : rows.length === 0 ? <Empty action={query ? <button className="ks-btn ks-btn--ghost" type="button" onClick={() => { setQuery(''); setPage(1) }}>{t("Clear search")}</button> : undefined}>{query ? t("No pending songs match.") : t("No songs are missing lyrics in the catalogs.")}</Empty> : rows.map(song => {
            const duration = durations.get(song.relPath)
            return <div className={`cx-tr${selected.has(song.relPath) ? ' on' : ''}`} role="row" key={song.relPath}>
              <span role="cell" className="ck"><input type="checkbox" aria-label={t("Select {{title}}", { title: song.title })} checked={selected.has(song.relPath)} disabled={busy} onChange={event => toggle([song.relPath], event.target.checked)} /></span>
              <span role="cell" title={song.title}>{song.title}</span><span role="cell" className="mute" title={song.artist}>{song.artist || <Missing kind="noArtist" />}</span><span role="cell" className="mute" title={song.album}>{song.album || <Missing kind="noAlbum" />}</span>
              <span role="cell" className="num" title={duration === undefined ? t("Duration unavailable") : undefined}>{duration === undefined ? <Missing kind="nodata" reason={t("Duration unavailable")} /> : `${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, '0')}`}</span>
            </div>
          })}
        </div>
      </div>
    </div>
    <nav className="cx-foot" aria-label={t("Pages of songs without lyrics")}><code>{t("{{from}}–{{to}} of {{total}}", { from: formatCount(shown.length ? (current - 1) * PAGE_SIZE + 1 : 0), to: formatCount(Math.min(current * PAGE_SIZE, shown.length)), total: formatCount(shown.length) })}</code><span className="cx-page-spacer" /><button className="cx-pg" type="button" aria-label={t("Previous")} disabled={current === 1} onClick={() => setPage(current - 1)}>‹</button>{pageNumbers.map((n, index) => <span className="cx-page-item" key={n}>{index > 0 && n - pageNumbers[index - 1] > 1 ? <span>…</span> : null}<button className="cx-pg" type="button" aria-current={n === current ? 'page' : undefined} onClick={() => setPage(n)}>{n}</button></span>)}<button className="cx-pg" type="button" aria-label={t("Next")} disabled={current === pages} onClick={() => setPage(current + 1)}>›</button></nav>
    <div className="cx-transcribe-foot"><div className="cx-estimate" title={!available ? t("No computer transcribes lyrics") : estimateTip}>{computer} · <code>{available && minutes !== null ? t('≈ {{n}} min', { n: formatCount(minutes) }) : available ? <Missing kind="unmeasured" /> : <Missing kind="unavailable" reason={t("No computer transcribes lyrics")} />}</code>{submitError ? <span role="alert">{t("Could not start transcription. Try again.")}</span> : null}{!available ? <span role="status">{t("No computer transcribes lyrics")}</span> : null}</div><button className="ks-btn ks-btn--ghost" type="button" disabled={busy} onClick={close}>{t("Cancel")}</button><button className="ks-btn ks-btn--go" type="button" disabled={!picked.length || busy || !available} onClick={() => void submit()}>{busy ? t("Sending…") : t("Transcribe {{n}}", { n: formatCount(picked.length) })}</button></div>
  </Modal>
}
