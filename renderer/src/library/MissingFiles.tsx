import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiPost, type ApiData } from '../data'
import { useSettings } from '../settings/context'
import { Modal } from '../settings/parts'
import { Page } from '../settings/sections/Head'
import './missing-files.css'

type Row = ApiData<'/api/library/missing', 'get'>['rows'][number]
type Match = ApiData<'/api/library/missing/preview', 'post'>['rows'][number]
type Outcome = ApiData<'/api/library/missing/remove', 'post'>
const key = ['library-missing-owner'] as const

function amount(n: number, noun: string) { return `${n} ${noun}${n === 1 ? '' : 's'}` }

function dependencies(rows: Row[], kept = true) {
  const accounts = new Set(rows.flatMap(r => r.references.accounts.map(a => a.name)))
  const playlists = new Set(rows.flatMap(r => r.references.playlists))
  const corrections = rows.filter(r => r.references.corrections.length).length
  return [accounts.size ? `${amount(accounts.size, 'account')} · ${[...accounts].join(', ')}` : '',
    playlists.size ? `${amount(playlists.size, 'playlist')} · ${[...playlists].join(', ')}` : '',
    corrections ? `${amount(corrections, 'song')} with corrections${kept ? ' kept' : ''}` : ''].filter(Boolean).join(' · ')
}

export function MissingFiles(): React.JSX.Element {
  const { go, admin } = useSettings()
  const client = useQueryClient()
  const query = useQuery({ queryKey: key, enabled: admin === true, queryFn: ({ signal }) => apiGet('/api/library/missing', { signal }) })
  const [selection, setSelection] = useState<{ rows: Row[]; action: 'folder' | 'file' | 'remove' } | null>(null)
  const [destination, setDestination] = useState('')
  const [preview, setPreview] = useState<Match[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [large, setLarge] = useState(false)
  const [result, setResult] = useState<Outcome | null>(null)
  const [canUndo, setCanUndo] = useState(false)
  const rows = query.data?.rows ?? []
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const group = row.cause === 'folder' ? row.folder : ''
    groups.set(group, [...(groups.get(group) ?? []), row])
  }
  const open = (items: Row[], action: 'folder' | 'file' | 'remove') => {
    setSelection({ rows: items, action }); setDestination(''); setPreview(null); setError(''); setLarge(false)
  }
  const refresh = async () => {
    await client.invalidateQueries()
    window.dispatchEvent(new CustomEvent('library-changed', { detail: { source: 'missing-files' } }))
  }
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : 'Could not update missing files') }
    finally { setBusy(false) }
  }
  const search = () => run(async () => {
    if (!selection) return
    const data = await apiPost('/api/library/missing/preview', { body: { relPaths: selection.rows.map(r => r.relPath),
      ...(selection.action === 'folder' ? { folder: destination } : { target: destination }) } })
    setPreview(data.rows)
  })
  const apply = () => run(async () => {
    const matches = (preview ?? []).flatMap(r => r.target && r.rev && !r.reason ? [{ relPath: r.relPath, target: r.target, rev: r.rev }] : [])
    const data = await apiPost('/api/library/missing/apply', { body: { rows: matches } })
    setCanUndo(false); setResult(data); setSelection(null); await refresh()
  })
  const remove = () => run(async () => {
    if (!selection) return
    const data = await apiPost('/api/library/missing/remove', { body: { relPaths: selection.rows.map(r => r.relPath), confirmLarge: large } })
    setCanUndo(true); setResult(data); setSelection(null); await refresh()
  })
  const undo = () => run(async () => {
    if (!result) return
    const started = await apiPost('/api/library/edits/{editId}/undo', { params: { path: { editId: result.editId } } })
    for (let attempt = 0; attempt < 40; attempt++) {
      const edit = await apiGet('/api/library/edits/{editId}', { params: { path: { editId: started.editId } } })
      if (edit.state !== 'applying' && edit.state !== 'planned') {
        setCanUndo(false)
        setResult({ editId: edit.id, rows: edit.rows.map(row => ({ relPath: row.rel_before, state: row.state, reason: row.reason })) })
        await refresh()
        return
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('Undo is still running')
  })
  const chosen = selection?.rows ?? []
  const count = chosen.length
  const needsLarge = count > (query.data?.libraryCount ?? 0) * .2
  const showRemoval = selection?.action === 'remove'
  return <Page id="missing" before={<button className="ks-link" type="button" onClick={() => go('biblioteca')}>Library ›</button>}
    sub={query.data ? `${amount(rows.length, 'song')} · ${amount(groups.size, 'cause')}` : undefined}>
    <div className="mf">
      {query.isPending ? <p role="status">Loading missing files…</p> : query.isError ? <p role="alert">Could not load missing files <button type="button" className="ks-link" onClick={() => void query.refetch()}>Retry</button></p> : null}
      {query.data && !query.data.libraryAvailable ? <p role="alert">Music folder unavailable</p> : null}
      {query.data && !rows.length ? <p>No missing files</p> : null}
      {[...groups].map(([folder, items]) => <section className="settings-block ks-group" key={folder} aria-label={folder || 'File not found'}>
        <div className="settings-block__head"><h3>{folder ? 'Folder not found' : 'File not found'}</h3><span>{items.length} {items.length === 1 ? 'song' : 'songs'}</span></div>
        {folder ? <div className="ks-row"><div className="ks-l"><b><code>{folder}/</code></b><span>{dependencies(items)}</span></div></div> : null}
        {items.map(row => <div className="ks-row mf-row" key={row.relPath}>
          <div className="ks-l"><b>{row.title}</b><code>{row.path}</code>
            <span>{dependencies([row])}</span>
            {row.missingSince ? <span>Missing since {new Date(row.missingSince).toLocaleDateString('en', { day: 'numeric', month: 'short' })}{row.size ? ` · ${new Intl.NumberFormat('en').format(row.size)} bytes` : ''}</span> : null}
            {row.movedTo ? <span>Found at <code>{row.movedTo}</code></span> : null}
          </div>
          {!folder || row.movedTo ? <button className="ks-btn" type="button" disabled={!query.data?.libraryAvailable} onClick={() => { open([row], 'file'); setDestination(row.movedTo ?? '') }}>Locate</button> : null}
          {!folder ? <button className="ks-btn" type="button" disabled={!query.data?.libraryAvailable} onClick={() => open([row], 'remove')}>Remove</button> : null}
        </div>)}
        {folder ? <div className="ks-row mf-actions"><button className="ks-btn" type="button" disabled={!query.data?.libraryAvailable} onClick={() => open(items, 'remove')}>Remove {amount(items.length, 'song')}</button><button className="ks-btn ks-btn--primary" type="button" disabled={!query.data?.libraryAvailable} onClick={() => open(items, 'folder')}>Find the folder</button></div> : null}
      </section>)}
      {result ? <section className="settings-block ks-group" aria-label="Result"><div className="ks-row"><div className="ks-l"><b>{amount(result.rows.filter(r => r.state === 'applied').length, 'song')} updated</b>{result.rows.filter(r => r.reason).map(r => <span key={r.relPath}>{r.relPath} · {r.reason}</span>)}</div>
        {canUndo ? <button type="button" className="ks-btn" disabled={busy} onClick={() => void undo()}>{busy ? 'Undoing…' : 'Undo'}</button> : null}</div>{error && !selection ? <p role="alert">{error}</p> : null}</section> : null}
      {selection ? <Modal title={showRemoval ? large ? `Remove ${amount(count, 'song')} from the library?` : `Remove ${count} ${count === 1 ? 'song' : 'songs'}?` : selection.action === 'folder' ? 'Find the folder' : 'Locate'} onClose={() => { if (!busy) setSelection(null) }}>
        <div className="mf">
          {showRemoval ? <>
            {large ? <p role="alert">{count} of {query.data?.libraryCount} library songs · more than 20%</p> : null}
            <ul className="mf-losses">{chosen.map(r => <li key={r.relPath}><b>{r.title}</b><code>{r.path}</code></li>)}</ul>
            <p>{dependencies(chosen, false)}</p>
            <dl className="mf-losses">{[
              ['Account references', chosen.reduce((n, r) => n + r.references.accounts.length, 0)],
              ['Playlist entries', chosen.reduce((n, r) => n + r.references.playlistEntries, 0)],
              ['Corrections', chosen.reduce((n, r) => n + r.references.corrections.length, 0)],
              ['Plays', chosen.reduce((n, r) => n + r.references.plays, 0)],
              ['Likes', chosen.reduce((n, r) => n + r.references.likes, 0)],
              ['Lyrics', chosen.filter(r => r.references.lyric).length],
              ['Analysis', chosen.filter(r => r.references.analysis).length],
              ['Stems', chosen.filter(r => r.references.stems).length],
            ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
          </> : <>
            <label className="mf-field">{selection.action === 'folder' ? 'Folder in music library' : 'File in music library'}<input value={destination} onChange={e => { setDestination(e.target.value); setPreview(null) }} placeholder={selection.action === 'folder' ? 'New Rips' : 'Album/song.mp3'} /></label>
            {preview ? <ul className="mf-losses">{preview.map(r => <li key={r.relPath}><code>{r.relPath}</code><span>→ {r.target ?? 'No match'}{r.reason ? ` · ${r.reason}` : ''}</span></li>)}</ul> : null}
          </>}
          {error ? <p role="alert">{error}</p> : null}
          <div className="mf-actions"><button type="button" className="ks-btn" disabled={busy} onClick={() => setSelection(null)}>Cancel</button>
            {showRemoval ? <button type="button" className="ks-btn" disabled={busy} onClick={() => { if (needsLarge && !large) setLarge(true); else void remove() }}>{busy ? 'Removing…' : large ? `Confirm removal of ${amount(count, 'song')}` : `Remove ${count} ${count === 1 ? 'song' : 'songs'}`}</button> :
              preview ? <button type="button" className="ks-btn" disabled={busy || !preview.some(r => r.target && !r.reason)} onClick={() => void apply()}>{busy ? 'Applying…' : `Apply ${preview.filter(r => !r.reason).length} matches`}</button> :
                <button type="button" className="ks-btn" disabled={busy || !destination.trim()} onClick={() => void search()}>{busy ? 'Finding…' : 'Preview'}</button>}
          </div>
        </div>
      </Modal> : null}
    </div>
  </Page>
}
