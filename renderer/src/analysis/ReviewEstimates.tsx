import { useLayoutEffect, useRef } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Play, Tags } from 'lucide-react'
import { apiGet } from '../data'
import type { SchemaAnalysisView, SchemaEstimateRow } from '../api/generated/schema'
import { Missing } from '../ui/react/components/Missing'
import { analysisKeys, useAnalysisSummary } from './data'
import { AnalysisValue } from './AnalysisValue'
import { ConfirmEstimate, useAnalysisConfirmation } from './confirmation'
import { BpmScale } from './BpmScale'

export function ReviewEstimates({ onPlay, onTags, onOpenInfo }: { onPlay: (row: SchemaEstimateRow) => void; onTags: (row: SchemaEstimateRow) => void; onOpenInfo?: (row: SchemaEstimateRow) => void }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const summary = useAnalysisSummary(true)
  const query = useInfiniteQuery({ staleTime: 10_000, queryKey: analysisKeys.estimates, initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => apiGet('/api/analysis/estimates', { params: { query: { limit: 50, ...(pageParam ? { after: pageParam } : {}) } }, signal }),
    getNextPageParam: last => last.after ?? undefined,
  })
  const { busy, save, scaleBpm, message } = useAnalysisConfirmation()
  const root = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const pendingFocus = useRef<{ rel: string; field: 'key' | 'bpm'; index: number } | null>(null)
  const rows = query.data?.pages.flatMap(page => page.rows).filter(row => row.keyEstimated || row.bpmEstimated) ?? []
  useLayoutEffect(() => {
    const target = pendingFocus.current
    if (!target || busy || query.isFetchingNextPage) return
    if (target.index >= rows.length && query.hasNextPage) {
      void query.fetchNextPage()
      return
    }
    pendingFocus.current = null
    const same = root.current?.querySelector<HTMLElement>(`[data-rel="${CSS.escape(target.rel)}"] [data-confirm]:not(:disabled)`)
    if (same) { same.focus(); return }
    const nextRows = [...rows.slice(target.index), ...rows.slice(0, target.index).reverse()]
    for (const row of nextRows) {
      const node = root.current?.querySelector<HTMLElement>(`[data-rel="${CSS.escape(row.relPath)}"]`)
      const button = node?.querySelector<HTMLElement>(`[data-confirm="${target.field}"]:not(:disabled)`) ?? node?.querySelector<HTMLElement>('[data-confirm]:not(:disabled)')
      if (button) { button.focus(); return }
    }
    heading.current?.focus()
  }, [busy, rows, query])
  const update = (row: SchemaEstimateRow, view: SchemaAnalysisView) => {
    const updated: SchemaEstimateRow = { ...row, keyConfidence: view.keyConfidence, bpmConfidence: view.bpmConfidence, key: view.key.value as string | null, bpm: view.bpm.value as number | null, keyEstimated: view.key.estimated, bpmEstimated: view.bpm.estimated, keySource: view.key.source, bpmSource: view.bpm.source, rev: view.rev }
    client.setQueryData<typeof query.data>(analysisKeys.estimates, current => {
      if (!current) return current
      const exists = current.pages.some(page => page.rows.some(item => item.relPath === row.relPath))
      const pages = current.pages.map(page => ({ ...page, rows: page.rows.map(item => item.relPath === row.relPath ? updated : item) }))
      if (!exists && pages[0]) {
        pages[0].rows = [...pages[0].rows, updated].sort((a, b) => a.artist.toLocaleLowerCase().localeCompare(b.artist.toLocaleLowerCase()) || a.title.toLocaleLowerCase().localeCompare(b.title.toLocaleLowerCase()) || a.relPath.localeCompare(b.relPath))
      }
      return { ...current, pages }
    })
  }

  const counts = summary.data?.estimated
  return <div ref={root} className="analysis-review">
    <header className="analysis-review__head"><h3 tabIndex={-1} ref={heading}>{t("Review estimates")}</h3>{counts ? <code>{t("{{n}} songs", { count: counts.songs, n: counts.songs })} · {t("{{n}} keys", { count: counts.keys, n: counts.keys })} · {t('{{n}} BPM', { n: counts.bpms })}</code> : null}</header>
    {query.isPending ? <Missing kind="loading" /> : query.isError ? <div role="alert"><Missing kind="unavailable" /><button type="button" className="k-btn k-btn--text" onClick={() => void query.refetch()}>{t("Retry")}</button></div> : rows.length === 0 ? <div className="analysis-review__empty"><Missing kind="nodata" /></div> : <table>
      <thead><tr><th scope="col">{t("Song")}</th><th scope="col">{t("Key_tone")}</th><th scope="col">BPM</th><th scope="col"><span className="k-sr-only">{t("Actions")}</span></th></tr></thead>
      <tbody>{rows.map((row, index) => <tr key={row.relPath} data-rel={row.relPath}>
        <td><div className="analysis-review__song"><b>{row.title}</b><span>{row.artist} · {row.album}</span></div></td>
        {(['key', 'bpm'] as const).map(field => <td key={field}><div className={`analysis-review__value${field === 'bpm' ? ' analysis-review__bpm' : ''}`}><AnalysisValue track={row} field={field} sheet={field === 'key'} onOpenInfo={onOpenInfo ? () => onOpenInfo(row) : undefined} /><span className="analysis-review__controls">{row[`${field}Estimated`] && row[field] != null ? <ConfirmEstimate field={field} value={row[field]} song={row.title} disabled={busy} onConfirm={() => { pendingFocus.current = { rel: row.relPath, field, index }; void save(row.relPath, row.rev, field, row[field], view => update(row, view), row.title) }} /> : null}
          {field === 'bpm' ? <BpmScale bpm={row.bpm} song={row.title} disabled={busy} onScale={(value, factor) => { pendingFocus.current = { rel: row.relPath, field, index }; void scaleBpm(row.relPath, row.rev, value, factor, row.bpmSource === 'fixed' ? row.bpm : null, view => update(row, view)) }} /> : null}
        </span></div></td>)}
        <td><div className="analysis-review__actions"><button type="button" className="k-btn k-btn--text" aria-label={t("Play {{song}}_listen", { song: row.title })} title={t("Play_listen")} onClick={() => onPlay(row)}><Play size={14} aria-hidden /></button><button type="button" className="k-btn k-btn--text" aria-label={t("Open tags for {{song}}", { song: row.title })} title={t("Open tags")} onClick={() => onTags(row)}><Tags size={14} aria-hidden /></button></div></td>
      </tr>)}</tbody>
    </table>}
    {message ? <p role="alert">{message}</p> : null}
    {query.hasNextPage ? <button type="button" className="k-btn k-btn--text" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{t("Load more")}</button> : null}
  </div>
}
