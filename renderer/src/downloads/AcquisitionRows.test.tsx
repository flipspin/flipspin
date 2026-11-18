import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiClient } from '../api/client'
import { setFakeBridgeForTest } from '../bridge'
import { refreshConnection } from '../connection/connection'
import { serverStatus } from '../settings/test-support'
import type { KrobiBridge, OfflinePin, OfflineStatus, OfflineTrackStatus, OutboxIntent } from '../lib/ipc'
import DownloadsMenu from './DownloadsMenu'
import JobsPanel from '../home/JobsPanel'
import i18n from '../i18n'
import { AcquisitionRow } from './AcquisitionRows'
import { refreshAcquisitions, type AcquisitionJob } from './acquisitionJobs'
import { reconcile, resetForIdentityChange, type JobView } from './downloadsStore'

vi.mock('../data/backend', async original => ({
  ...await original<typeof import('../data/backend')>(),
  getApiClient: () => Promise.resolve(createApiClient('http://acquisition.test')),
}))
let requests: Request[]
let jobs: AcquisitionJob[]
let ledger: JobView[]
let local: OfflineStatus
let pins: OfflinePin[]
let localRetries: unknown[]
let outbox: OutboxIntent[]
let outboxActions: { action?: string; id?: string }[]
const offlineListeners = new Set<() => void>()
let restore: () => void
let refuse = false
const item = { idx: 0, item: 'Prism Dust', state: 'failed', reason: 'no-encontrada', stage: 'match', detail: { index: 0, title: 'Prism Dust' } } as const
// A download that may work next time: the case Retry is for.
const transient = { ...item, reason: 'fallo-descarga', stage: 'fetch', detail: { ...item.detail, kind: 'broken' } } as const
const job = (overrides: Partial<AcquisitionJob> = {}): AcquisitionJob => ({ id: 'a1', title: 'Chladni Figures', account_id: 'u1', state: 'parcial', expected_tracks: 12, imported_tracks: 11, stages: { match: 'm1', fetch: 'f1' }, items: [{ ...item }], ...overrides })
beforeEach(async () => {
  requests = []; jobs = []; ledger = []; refuse = false; pins = []; localRetries = []
  outbox = []; outboxActions = []; offlineListeners.clear()
  local = { pins: 0, files: 0, bytes: 0, tracks: [] }
  restore = setFakeBridgeForTest({ invoke: (async (channel: string, request?: { action?: string; id?: string }) => {
    if (channel === 'server:get-status') return serverStatus({ connection: { state: 'connected', since: 0, attempt: 1, lastError: null, checks: [] } })
    if (channel === 'offline:mode') return { forced: false }
    if (channel === 'offline:sync') return { ok: true }
    if (channel === 'offline:snapshot') return undefined
    if (channel === 'offline:status') return local
    if (channel === 'offline:pools') return { offline: { files: 0, bytes: 0, location: '/offline' }, cache: { files: 0, bytes: 0, location: '/cache' }, cacheBudget: 1e9, pins }
    if (channel === 'offline:pin') {
      localRetries.push(request)
      return refuse ? { ok: false, reason: 'no-space' } : { ok: true }
    }
    if (channel === 'offline:outbox') {
      if (request?.action !== 'list') {
        outboxActions.push(request!)
        outbox = request?.action === 'discard' ? outbox.filter(row => row.id !== request.id)
          : outbox.map(row => row.id === request?.id ? { ...row, state: 'queued', lastError: null, attempts: 0 } : row)
        offlineListeners.forEach(refresh => refresh())
      }
      return outbox
    }
    throw new Error(channel)
  }) as KrobiBridge['invoke'], on: ((channel: string, refresh: () => void) => {
    if (channel === 'offline:changed') offlineListeners.add(refresh)
    return () => { offlineListeners.delete(refresh) }
  }) as KrobiBridge['on'] })
  vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
    requests.push(request)
    const path = new URL(request.url).pathname
    if (path === '/api/jobs') return Response.json({ jobs: ledger, degraded: [] })
    if (path === '/api/me') return Response.json({ id: 'u1', label: 'Lucía' })
    if (path === '/api/downloads/youtube-search') return Response.json({ query: 'Prism Dust', results: [
      { id: 'chosen', url: 'https://www.youtube.com/watch?v=chosen', title: 'Chosen recording', duration: 200, uploader: 'Channel' },
    ] })
    if (path === '/api/acquisition/requests/clear') {
      if (refuse) return Response.json({ detail: 'clear-failed' }, { status: 500 })
      const cleared = jobs.filter(row => !['pending', 'approved', 'fetching', 'importing'].includes(row.state)).length
      jobs = jobs.filter(row => ['pending', 'approved', 'fetching', 'importing'].includes(row.state))
      return Response.json({ cleared })
    }
    if (path.startsWith('/api/acquisition/requests/') && path.endsWith('/clear')) {
      if (refuse) return Response.json({ detail: 'clear-failed' }, { status: 409 })
      jobs = jobs.filter(row => row.id !== path.split('/').at(-2))
      return Response.json({ cleared: 1 })
    }
    if (path === '/api/jobs/clear') {
      ledger = ledger.filter(row => ['queued', 'waiting', 'running'].includes(row.state))
      return Response.json({ cleared: 1 })
    }
    if (path.endsWith('/retry')) {
      if (refuse) return Response.json({ detail: 'cannot-retry' }, { status: 409 })
      jobs = jobs.map(row => ({ ...row, state: 'fetching', items: [{ ...item, stage: 'fetch', state: 'running', reason: null }], stages: { match: 'm2', fetch: 'f2' } }))
      return Response.json(jobs[0])
    }
    if (path === '/api/acquisition/requests') return Response.json({ requests: jobs })
    if (path.startsWith('/api/acquisition/requests/')) return Response.json(jobs.find(job => path.endsWith(job.id)))
    return Response.json({ detail: 'Not Found' }, { status: 404 })
  }))
  await refreshConnection()
  resetForIdentityChange(); await reconcile()
})
afterEach(() => { restore(); vi.unstubAllGlobals() })
async function show(popover = false) {
  render(popover ? <DownloadsMenu /> : <JobsPanel />)
  await act(() => refreshAcquisitions())
  if (popover) await userEvent.click(screen.getByRole('button', { name: /Trabajos/ }))
}
it.each([false, true])('clears finished acquisitions alone from Home/popover (%s)', async popover => {
  jobs = ['completo', 'parcial', 'fallido', 'rechazado'].map(state => job({ id: state, title: state, state }))
  await show(popover)
  expect(screen.getAllByRole('article')).toHaveLength(4)
  await userEvent.click(screen.getByRole('button', { name: 'Limpiar' }))
  await waitFor(() => expect(screen.queryAllByRole('article')).toHaveLength(0))
  expect(screen.getByText('Nada en curso')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Limpiar' })).toBeNull()
  expect(requests.filter(request => request.method === 'POST').map(request => new URL(request.url).pathname))
    .toEqual(['/api/acquisition/requests/clear'])
  expect(requests.at(-1)?.url).toBe('http://acquisition.test/api/acquisition/requests')
})
it.each(['pending', 'approved', 'fetching', 'importing'])('does not offer Limpiar for a live %s acquisition', async state => {
  jobs = [job({ state })]
  await show(true)
  expect(screen.getByRole('article', { name: 'Chladni Figures' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Limpiar' })).toBeNull()
  expect(requests.some(request => request.method === 'POST')).toBe(false)
})
it('clears both lists and keeps live acquisitions', async () => {
  jobs = [job(), job({ id: 'live', title: 'Still downloading', state: 'fetching' })]
  ledger = [{ id: 'general', label: 'General job', kind: 'download', state: 'succeeded', total: 1, succeeded: 1,
    failed: 0, skipped: 0, percent: 100, phase: null, item: null, waitingOn: null, startedAt: 1, endedAt: 2,
    attempt: 1, failedCount: 0, canCancel: false, canRetry: false }]
  await reconcile()
  await show(true)
  await userEvent.click(screen.getByRole('button', { name: 'Limpiar' }))
  await waitFor(() => expect(screen.getAllByRole('article').map(row => row.getAttribute('aria-label'))).toEqual(['Still downloading']))
  expect(requests.filter(request => request.method === 'POST').map(request => new URL(request.url).pathname).sort())
    .toEqual(['/api/acquisition/requests/clear', '/api/jobs/clear'])
  expect(screen.queryByRole('button', { name: 'Limpiar' })).toBeNull()
})
it('retains the acquisition and existing error message when clearing fails', async () => {
  jobs = [job()]
  await show()
  refuse = true
  await userEvent.click(screen.getByRole('button', { name: 'Limpiar' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo limpiar. Inténtalo de nuevo.')
  expect(screen.getByRole('article', { name: 'Chladni Figures' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Limpiar' })).toBeEnabled()
})
it.each([false, true])('shows the same compact failure row and expansion in Home/popover (%s)', async popover => {
  jobs = [job({ items: [{ ...transient }] })]; await show(popover)
  const row = within(await screen.findByRole('article', { name: 'Chladni Figures' }))
  expect(row.getByText('DL')).toHaveStyle({ background: 'var(--green)' })
  expect(row.getByText('1 de 12 falló')).toBeInTheDocument()
  expect(row.queryByText(/Agregar/)).toBeNull()
  expect(row.queryByLabelText('Etapas')).toBeNull()
  expect(row.queryByText('Prism Dust')).toBeNull()
  const toggle = row.getByRole('button', { name: 'Ver 1' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await userEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(row.getByRole('list', { name: 'Canciones que fallaron' })).toHaveTextContent('Prism DustFalló la descarga')
  expect(row.getAllByRole('button', { name: 'Reintentar' })).toHaveLength(1)
  await userEvent.click(toggle)
  expect(row.queryByText('Prism Dust')).toBeNull()
  await userEvent.click(toggle)
  await userEvent.click(row.getByRole('button', { name: 'Reintentar' }))
  await waitFor(() => expect(screen.queryByText('Falló la descarga')).toBeNull())
  const retry = requests.find(request => request.method === 'POST')!
  expect(retry.url).toBe('http://acquisition.test/api/acquisition/requests/a1/retry')
  expect(retry.method).toBe('POST')
  const running = within(screen.getByRole('article', { name: 'Chladni Figures' }))
  expect(running.getByText('Descargando al nido')).toBeInTheDocument()
  expect(running.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '92')
  expect(running.getByText('92%')).toBeInTheDocument()
  expect(running.getByText('· Prism Dust · 11 / 12')).toBeInTheDocument()
})
it('retains failed outcomes and reports a refused retry', async () => {
  jobs = [job({ items: [{ ...transient }] })]; await show(); refuse = true
  await userEvent.click(screen.getByRole('button', { name: 'Ver 1' }))
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo completar la acción')
  expect(screen.getByText('Falló la descarga')).toBeInTheDocument()
})
it.each([
  ['request', 'Buscando'], ['match', 'Buscando'], ['fetch', 'Descargando al nido'],
  ['import', 'Importando'], ['link', 'Importando'],
] as const)('names the active %s stage with one status word', async (stage, word) => {
  jobs = [job({ state: 'fetching', items: [{ ...item, stage, state: 'running', reason: null }] })]
  await show()
  expect(screen.getByText(word)).toBeInTheDocument()
  expect(screen.getByText('· Prism Dust · 11 / 12')).toBeInTheDocument()
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '92')
  expect(screen.queryByLabelText('Etapas')).toBeNull()
})
it.each([undefined, new Date('2026-11-09T19:40:00Z').getTime() / 1000])('shows a YouTube pause in En espera, with an optional until-time (%s)', async until => {
  jobs = [job({ state: 'fetching', items: [{ ...item, state: 'running', stage: 'fetch', reason: 'en-pausa', detail: { until } }] })]
  await show(true)
  const time = until === undefined ? '' : new Date(until * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
  const word = until === undefined ? 'En pausa' : `Reintento a las ${time}`
  const pause = screen.getByText(word)
  expect(pause.parentElement).toHaveAttribute('title', until === undefined ? 'Todas las canciones de YouTube esperan' : `Todas las canciones de YouTube esperan · reintento a las ${time}`)
  expect(pause.previousElementSibling).toHaveStyle({ background: 'var(--yellow)' })
  expect(screen.getByText('En espera').parentElement?.parentElement).toContainElement(screen.getByRole('article'))
  expect(screen.queryByRole('progressbar')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull()
})
it.each([
  ['broken', 'YouTube no envió el audio'], ['rate-limited', 'YouTube está saturado'],
  ['blocked', 'YouTube está rechazando las solicitudes'], ['network', 'No se puede conectar con YouTube'],
  ['auth-required', 'YouTube pide que inicies sesión'],
] as const)('says why the source is paused (%s) beside the waiting song', async (kind, why) => {
  jobs = [job({ state: 'fetching', items: [{ ...item, state: 'running', stage: 'fetch', reason: 'en-pausa', detail: { until: 1794685200, kind } }] })]
  await show(true)
  expect(screen.getByText(`· ${why} · Prism Dust · 11 / 12`)).toBeInTheDocument()
})
it('shows the running song and stage ahead of queued items', async () => {
  jobs = [job({ state: 'fetching', items: [
    { ...item, state: 'queued', reason: null },
    { ...item, idx: 1, item: 'Current song', state: 'running', stage: 'fetch', reason: null, detail: {} },
  ] })]
  await show()
  expect(screen.getByText('Descargando al nido')).toBeInTheDocument()
  expect(screen.getByText('· Current song · 11 / 12')).toBeInTheDocument()
})
it('lists computer downloads separately and leaves upload/outbox row hooks', async () => {
  local = { pins: 1, files: 1, bytes: 100, tracks: [{ key: 'a/Local.mp3', pool: 'offline', state: 'descargado', bytes: 100, etag: null, verifiedAt: 1, error: null, lastPlayedAt: null }] }
  render(<JobsPanel uploadBatches={<div data-testid="upload-hook" />} pendingChanges={<div data-testid="outbox-hook" />} />)
  await act(() => refreshAcquisitions())
  const row = within(await screen.findByRole('article', { name: 'a/Local.mp3' }))
  expect(row.getByLabelText('Este equipo')).toHaveTextContent('EQ')
  expect(row.getByLabelText('Este equipo')).toHaveClass('text-white')
  expect(row.getByLabelText('Este equipo')).toHaveStyle({ background: 'var(--blue)' })
  expect(row.getByText('Descargado')).toBeInTheDocument()
  expect(screen.getByTestId('upload-hook')).toBeInTheDocument()
  expect(screen.getByTestId('outbox-hook')).toBeInTheDocument()
  expect(screen.queryByText('Nada en curso')).toBeNull()
})

it('replaces generic ledger stages with one request row, including retired attempts after retry', async () => {
  jobs = [job({ items: [{ ...transient }] })]
  const stage = (id: string, label: string): JobView => ({ id, label, kind: 'download', state: 'succeeded', total: 12, succeeded: 11, failed: 1, skipped: 0, percent: 100, phase: null, item: null, waitingOn: null, startedAt: 1, endedAt: 2, attempt: 1, failedCount: 1, canCancel: false, canRetry: true })
  ledger = [stage('m1', 'match'), stage('f1', 'fetch'), stage('other', 'Other job')]
  await reconcile()
  await show(true)
  expect(screen.getAllByRole('article').map(row => row.getAttribute('aria-label'))).toEqual(['Chladni Figures', 'Other job'])
  await userEvent.click(within(screen.getByRole('article', { name: 'Chladni Figures' })).getByRole('button', { name: 'Ver 1' }))
  await userEvent.click(within(screen.getByRole('article', { name: 'Chladni Figures' })).getByRole('button', { name: 'Reintentar' }))
  await waitFor(() => expect(screen.queryByText('Falló la descarga')).toBeNull())
  expect(screen.getAllByRole('article').map(row => row.getAttribute('aria-label'))).toEqual(['Chladni Figures', 'Other job'])
})
it('omits requester information from every request', async () => {
  jobs = [job({ account_id: 'u2' })]
  await show()
  const row = within(await screen.findByRole('article', { name: 'Chladni Figures' }))
  expect(row.queryByText('Agregar · Lucía')).toBeNull()
  expect(row.queryByText('Sin datos')).toBeNull()
  expect(row.queryByText(/Agregar/)).toBeNull()
})

const pendingChange = (overrides: Partial<OutboxIntent> = {}): OutboxIntent => ({
  id: 'change', idempotencyKey: 'change', intent: 'library-add', body: '{}',
  state: 'failed', attempts: 5, createdAt: 1, lastError: '503:busy', ...overrides,
})
it.each([false, true])('merges pending changes into the shared rows and single total in Home/popover (%s)', async popover => {
  jobs = [job()]
  local = { pins: 1, files: 1, bytes: 100, tracks: [{ key: 'a/Local.mp3', pool: 'offline', state: 'descargado', bytes: 100, etag: null, verifiedAt: 1, error: null, lastPlayedAt: null }] }
  outbox = [pendingChange({ intent: 'playlist-edit', body: JSON.stringify({ tracks: [{ title: 'Local version' }] }), lastError: '412:' + JSON.stringify({ detail: { current: { tracks: [{ title: 'Nest version' }] } } }) })]
  await show(popover)
  const panel = popover ? screen.getByRole('dialog', { name: 'Trabajos' }) : screen.getByRole('region', { name: 'Trabajos' })
  const scope = within(panel)
  await scope.findByRole('article', { name: 'Editar playlist' })
  const header = scope.getByText('Trabajos').parentElement!
  expect(within(header).getByText('3')).toHaveClass('font-mono')
  expect(scope.getAllByRole('article').map(row => row.getAttribute('aria-label'))).toEqual(['Editar playlist', 'Chladni Figures', 'a/Local.mp3'])
  expect(scope.getAllByText('1 cambios esperan al nido')).toHaveLength(1)
  expect(scope.queryByText('Nada en curso')).toBeNull()
  const change = within(scope.getByRole('article', { name: 'Editar playlist' }))
  await userEvent.click(change.getByText('Ver ambas versiones'))
  expect(change.getByText('Local version')).toBeVisible()
  expect(change.getByText('Nest version')).toBeVisible()
  expect(change.queryByRole('button', { name: 'Reintentar' })).toBeNull()
  if (popover) expect(screen.getByTestId('jobs-count')).toHaveTextContent(/^2$/)
})
it('retries and discards pending changes without a second list or an empty-state message', async () => {
  outbox = [pendingChange()]
  await show(true)
  const panel = within(screen.getByRole('dialog', { name: 'Trabajos' }))
  // The pending changes arrive through the bridge asynchronously: wait for them, don't assume they're there.
  const retry = await panel.findByRole('button', { name: 'Reintentar' })
  expect(panel.queryByText('Nada en curso')).toBeNull()
  await userEvent.click(retry)
  await waitFor(() => expect(panel.queryByRole('button', { name: 'Reintentar' })).toBeNull())
  expect(outboxActions).toEqual([{ action: 'retry', id: 'change' }])
  expect(panel.getAllByRole('article')).toHaveLength(1)
  await userEvent.click(panel.getByRole('button', { name: 'Descartar' }))
  await waitFor(() => expect(screen.queryByTestId('jobs-count')).toBeNull())
  expect(outboxActions).toEqual([{ action: 'retry', id: 'change' }, { action: 'discard', id: 'change' }])
  expect(panel.getByText('Nada en curso')).toBeInTheDocument()
})

const localTrack = (key: string, state: OfflineTrackStatus['state'], error: string | null = null): OfflineTrackStatus => ({
  key, state, pool: 'offline', bytes: 100, error, etag: null, verifiedAt: null, lastPlayedAt: null,
})
const ledgerJob = (id: string, state: JobView['state']): JobView => ({
  id, label: id, state, kind: 'download', total: 1, succeeded: 0, failed: 0, skipped: 0, percent: 0,
  phase: null, item: null, waitingOn: null, startedAt: 1, endedAt: null, attempt: 1, failedCount: 0,
  canCancel: false, canRetry: false,
})
it.each([false, true])('groups acquisitions, local downloads and ledger jobs together and preserves all counts (%s)', async popover => {
  jobs = [
    job({ id: 'complete', title: 'Complete', state: 'completo', expected_tracks: 1, imported_tracks: 1, items: [] }),
    job({ id: 'pause', title: 'Paused', state: 'fetching', items: [{ ...item, state: 'queued', reason: 'en-pausa' }] }),
    job({ id: 'active', title: 'Active', state: 'fetching', items: [{ ...item, state: 'running', stage: 'fetch', reason: null }] }),
    job({ id: 'failed', title: 'Failed', state: 'fallido' }),
  ]
  ledger = [ledgerJob('Ledger done', 'succeeded'), ledgerJob('Ledger queued', 'queued'), ledgerJob('Ledger running', 'running')]
  local.tracks = [localTrack('Local done', 'descargado'), localTrack('Local queued', 'en fila'), localTrack('Local running', 'descargando'), localTrack('Local failed', 'fallido')]
  await reconcile()
  await show(popover)
  const panel = popover ? screen.getByRole('dialog', { name: 'Trabajos' }) : screen.getByRole('region', { name: 'Trabajos' })
  const header = within(panel).getByText('Trabajos').parentElement!
  expect(within(header).getByText('11')).toHaveClass('font-mono')
  expect(within(header).getByRole('button', { name: 'Limpiar' })).toBeInTheDocument()
  if (!popover) {
    expect(panel).toHaveClass('border-2', 'border-black', 'shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]')
    expect(header).toHaveClass('border-t-4')
    expect(header).toHaveStyle({ borderTopColor: 'var(--green)' })
  } else {
    expect(screen.getByRole('button', { name: 'Trabajos · 2 con fallos · 5 en curso' })).toBeInTheDocument()
    expect(screen.getByTestId('jobs-count')).toHaveTextContent('2')
  }
  for (const [group, names] of [
    ['En curso', ['Active', 'Ledger running', 'Local running']],
    ['En espera', ['Paused', 'Ledger queued', 'Local queued']],
    ['Terminados', ['Complete', 'Failed', 'Ledger done', 'Local done', 'Local failed']],
  ] as const) {
    const heading = within(panel).getByText(group).parentElement!
    expect(within(heading).getByText(String(names.length))).toBeInTheDocument()
    const articles = within(heading.parentElement!).getAllByRole('article')
    expect(articles.map(row => row.getAttribute('aria-label'))).toEqual(names)
    articles.forEach(row => expect(row).toHaveClass('px-3', 'py-2'))
  }
  expect(within(screen.getByRole('article', { name: 'Complete' })).getByText('· 1 canción')).toBeInTheDocument()
  expect(within(screen.getByRole('article', { name: 'Local running' })).getByText('Descargando a este equipo')).toBeInTheDocument()
  expect(within(screen.getByRole('article', { name: 'Local running' })).queryByRole('progressbar')).toBeNull()
})
it('deduplicates failed outcomes and offers a single retry after the full failure list', async () => {
  jobs = [job({ state: 'fallido', items: [
    { ...item }, { ...item, idx: 10, stage: 'fetch' },
    { ...item, idx: 1, item: 'Second song', reason: 'fallo-descarga', detail: { index: 1 } },
  ] })]
  await show()
  expect(screen.getByText('2 de 12 fallaron')).toBeInTheDocument()
  expect(screen.queryByText('No se encontró')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Ver 2' }))
  const failures = within(screen.getByRole('list', { name: 'Canciones que fallaron' }))
  expect(failures.getAllByRole('listitem')).toHaveLength(2)
  expect(failures.getByText('Prism Dust')).toBeInTheDocument()
  expect(failures.getByText('Second song')).toBeInTheDocument()
  expect(failures.getByText('No se encontró')).toBeInTheDocument()
  expect(failures.getByText('Falló la descarga')).toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: 'Reintentar' })).toHaveLength(1)
})
it.each(['fallido', 'ya no está en el nido'] as const)('retries a local %s download through its existing pin and reports failure', async state => {
  local.tracks = [localTrack('Local.mp3', state, 'no-space')]
  pins = [{ id: 'pin', kind: 'album', ref: 'Album', tracks: ['Local.mp3', 'Other.mp3'] }]
  await show()
  const row = within(await screen.findByRole('article', { name: 'Local.mp3' }))
  const word = row.getByText(state === 'fallido' ? 'Sin espacio' : 'Ya no está en el nido')
  expect(word.previousElementSibling).toHaveStyle({ background: 'var(--rose)' })
  await userEvent.click(row.getByRole('button', { name: 'Reintentar' }))
  await waitFor(() => expect(localRetries).toEqual([{ kind: 'album', ref: 'Album', tracks: [
    { key: 'Local.mp3', inLibrary: true }, { key: 'Other.mp3', inLibrary: true },
  ] }]))
  refuse = true
  await userEvent.click(row.getByRole('button', { name: 'Reintentar' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo completar la acción')
  expect(row.getByRole('button', { name: 'Reintentar' })).toBeEnabled()
})


it.each(['es', 'en'])('names a missing-song recovery while running, done and failed (%s)', async language => {
  await i18n.changeLanguage(language);
  try {
    const recovery = job({ provider: 'library-readd', title: 'Prism Dust', state: 'fetching', expected_tracks: 1, imported_tracks: 0, items: [] });
    const view = render(<AcquisitionRow job={recovery} />);
    expect(screen.getByText(language === 'es' ? 'Volver a agregar · Prism Dust' : 'Re-adding · Prism Dust')).toBeInTheDocument();
    view.rerender(<AcquisitionRow job={{ ...recovery, state: 'completo', imported_tracks: 1 }} />);
    expect(screen.getByText(language === 'es' ? 'De vuelta en el nido' : 'Back in the nest')).toBeInTheDocument();
    expect(screen.getByTitle(language === 'es' ? '1 canción' : '1 song')).toBeInTheDocument();
    view.rerender(<AcquisitionRow job={{ ...recovery, state: 'fallido', items: [{ ...item }] }} />);
    expect(screen.queryByRole('button', { name: language === 'es' ? 'Ver 1' : 'View 1' })).toBeNull();
    expect(screen.getByText(language === 'es' ? 'No se encontró' : 'Not found')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: language === 'es' ? 'Elegir otro video' : 'Choose another video' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: language === 'es' ? 'Reintentar' : 'Retry' })).toBeNull();
  } finally { await i18n.changeLanguage('es'); }
});

describe('stage jobs that reach the ledger first', () => {
  it('are hidden by their stage label before the acquisition list knows their ids', async () => {
    const { withoutAcquisitionStages } = await import('./acquisitionJobs')
    const empty = { requests: [], who: null, accountId: null, error: false, stageIds: new Set<string>() }
    const jobs = [
      { id: 'a', label: 'request' }, { id: 'b', label: 'match' }, { id: 'c', label: 'fetch' },
      { id: 'd', label: 'import' }, { id: 'e', label: 'link' }, { id: 'f', label: 'Mi playlist' },
    ]
    expect(withoutAcquisitionStages(jobs, empty).map(job => job.id)).toEqual(['f'])
  })
})


it('clears only the selected finished acquisition and retains it on failure', async () => {
  jobs = [job(), job({ id: 'second', title: 'Other collection' }), job({ id: 'live', title: 'Downloading', state: 'fetching' })]
  await show(true)
  const clear = within(screen.getByRole('article', { name: 'Chladni Figures' })).getByRole('button', { name: 'Quitar de la lista' })
  expect(clear).toHaveAttribute('title', 'Quitar de la lista')
  refuse = true
  await userEvent.click(clear)
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo completar la acción')
  expect(screen.getByRole('article', { name: 'Chladni Figures' })).toBeInTheDocument()
  refuse = false
  await userEvent.click(clear)
  await waitFor(() => expect(screen.queryByRole('article', { name: 'Chladni Figures' })).toBeNull())
  expect(requests.find(request => request.url.endsWith('/api/acquisition/requests/a1/clear'))?.method).toBe('POST')
  expect(screen.getByRole('article', { name: 'Other collection' })).toBeInTheDocument()
  expect(within(screen.getByRole('article', { name: 'Downloading' })).queryByRole('button', { name: 'Quitar de la lista' })).toBeNull()
})

it.each([false, true])('manually searches a failed acquisition item and retries its original request (%s)', async popover => {
  jobs = [job({ tracks: [{ title: 'Prism Dust', artist: 'Artist', duration_s: 200 }] })]
  await show(popover)
  await userEvent.click(screen.getByRole('button', { name: 'Ver 1' }))
  await userEvent.click(screen.getByRole('button', { name: 'Elegir otro video' }))
  expect(requests.filter(request => request.method === 'POST')).toHaveLength(0)
  const modal = within(screen.getByRole('dialog', { name: 'Buscar de otra forma' }))
  expect(modal.getByRole('textbox', { name: 'Buscar en YouTube' })).toHaveValue('Prism Dust Artist audio')
  await userEvent.click(modal.getByRole('button', { name: 'Buscar' }))
  await modal.findByText('Chosen recording')
  await userEvent.click(modal.getByRole('button', { name: 'Descargar' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Buscar de otra forma' })).toBeNull())
  const posted = requests.filter(request => request.method === 'POST')
  expect(posted.map(request => new URL(request.url).pathname)).toEqual([
    '/api/downloads/youtube-search', '/api/acquisition/requests/a1/retry',
  ])
  expect(await posted[1].clone().json()).toEqual({ index: 0, youtube_url: 'https://www.youtube.com/watch?v=chosen' })
  expect(screen.getByRole('article', { name: 'Chladni Figures' })).toBeInTheDocument()
})
it('leaves import failures with Retry', async () => {
  jobs = [job({ items: [{ ...item, reason: 'fallo-importar' }] })]
  await show()
  await userEvent.click(screen.getByRole('button', { name: 'Ver 1' }))
  expect(screen.queryByRole('button', { name: 'Elegir otro video' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Reintentar' })).toBeEnabled()
})
it('retains manual search results when acquisition retry fails', async () => {
  jobs = [job()]; await show()
  await userEvent.click(screen.getByRole('button', { name: 'Ver 1' }))
  await userEvent.click(screen.getByRole('button', { name: 'Elegir otro video' }))
  const modal = within(screen.getByRole('dialog', { name: 'Buscar de otra forma' }))
  await userEvent.click(modal.getByRole('button', { name: 'Buscar' }))
  await modal.findByText('Chosen recording')
  refuse = true
  await userEvent.click(modal.getByRole('button', { name: 'Descargar' }))
  expect(await modal.findByRole('alert')).toBeInTheDocument()
  expect(modal.getByText('Chosen recording')).toBeInTheDocument()
  expect(modal.getByRole('button', { name: 'Descargar' })).toBeEnabled()
})

it('clears finished acquisition and ledger rows even when the follow-up reads fail', async () => {
  jobs = ['completo', 'parcial', 'fallido'].map(state => job({ id: state, title: state, state }))
  jobs.push(job({ id: 'live-acquisition', title: 'Live acquisition', state: 'fetching' }))
  ledger = [ledgerJob('Finished ledger', 'succeeded'), ledgerJob('Live ledger', 'running')]
  await reconcile()
  await show(true)
  expect(screen.getAllByRole('article')).toHaveLength(6)
  const fetchBeforeClear = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async input => {
    const request = input as Request
    if (request.method === 'GET' && ['/api/jobs', '/api/acquisition/requests'].includes(new URL(request.url).pathname)) {
      return Response.json({ detail: 'refresh-failed' }, { status: 503 })
    }
    return fetchBeforeClear(request)
  })
  await userEvent.click(screen.getByRole('button', { name: 'Limpiar' }))
  await waitFor(() => expect(screen.getAllByRole('article').map(row => row.getAttribute('aria-label')))
    .toEqual(['Live acquisition', 'Live ledger']))
  expect(jobs.map(job => job.id)).toEqual(['live-acquisition'])
  expect(ledger.map(job => job.id)).toEqual(['Live ledger'])
  expect(requests.filter(request => request.method === 'POST').map(request => new URL(request.url).pathname).sort())
    .toEqual(['/api/acquisition/requests/clear', '/api/jobs/clear'])
})

it.each(['acquisition', 'ledger'] as const)('waits for both clear calls when %s fails, then removes only the successful rows', async failure => {
  jobs = ['completo', 'parcial', 'fallido'].map(state => job({ id: state, title: state, state }))
  ledger = [ledgerJob('Finished ledger', 'succeeded')]
  await reconcile()
  await show(true)
  const acquisitionPath = '/api/acquisition/requests/clear'
  const ledgerPath = '/api/jobs/clear'
  const failedPath = failure === 'acquisition' ? acquisitionPath : ledgerPath
  const successfulPath = failure === 'acquisition' ? ledgerPath : acquisitionPath
  const fetchBeforeClear = vi.mocked(fetch).getMockImplementation()!
  let finishClear!: () => void
  vi.mocked(fetch).mockImplementation(async input => {
    const request = input as Request
    const path = new URL(request.url).pathname
    if (path === failedPath) return Response.json({ detail: 'clear-failed' }, { status: 503 })
    if (path === successfulPath) await new Promise<void>(resolve => { finishClear = resolve })
    return fetchBeforeClear(request)
  })
  try {
    await userEvent.click(screen.getByRole('button', { name: 'Limpiar' }))
    await waitFor(() => expect(finishClear).toBeTypeOf('function'))
    expect(screen.getByRole('button', { name: 'Limpiar' })).toBeDisabled()
    expect(screen.queryByRole('alert')).toBeNull()
    await act(async () => finishClear())
    await waitFor(() => expect(screen.getAllByRole('article').map(row => row.getAttribute('aria-label')))
      .toEqual(failure === 'acquisition' ? ['completo', 'parcial', 'fallido'] : ['Finished ledger']))
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo limpiar')
    expect(screen.getByRole('button', { name: 'Limpiar' })).toBeEnabled()
  } finally { if (finishClear) await act(async () => finishClear()) }
})

it.each(['acquisition', 'ledger'] as const)('does not wait for or restore a stale %s poll after clearing both lists', async source => {
  jobs = ['completo', 'parcial', 'fallido'].map(state => job({ id: state, title: state, state }))
  ledger = [ledgerJob('Finished ledger', 'succeeded'), ledgerJob('m1', 'succeeded')]
  await reconcile()
  await show(true)
  expect(screen.getAllByRole('article')).toHaveLength(4) // the acquisition's ledger stage is hidden
  const fetchBeforeClear = vi.mocked(fetch).getMockImplementation()!
  const pollPath = source === 'acquisition' ? '/api/acquisition/requests' : '/api/jobs'
  let finishPoll!: () => void
  vi.mocked(fetch).mockImplementation(async input => {
    const request = input as Request
    const response = await fetchBeforeClear(request)
    if (request.method === 'GET' && new URL(request.url).pathname === pollPath && !finishPoll) {
      await new Promise<void>(resolve => { finishPoll = resolve })
    }
    return response
  })
  const pendingPoll = source === 'acquisition' ? refreshAcquisitions() : reconcile()
  try {
    await waitFor(() => expect(finishPoll).toBeTypeOf('function'))
    await userEvent.click(screen.getByRole('button', { name: 'Limpiar' }))
    await waitFor(() => expect(screen.queryAllByRole('article')).toHaveLength(0))
    await act(async () => { finishPoll(); await pendingPoll })
    expect(screen.queryAllByRole('article')).toHaveLength(0)
    expect(screen.getByText('Nada en curso')).toBeInTheDocument()
  } finally { if (finishPoll) await act(async () => { finishPoll(); await pendingPoll }) }
})

it('names another source in a backoff tooltip', async () => {
  jobs = [job({ state: 'fetching', items: [{ ...item, state: 'queued', stage: 'fetch', reason: 'en-pausa', detail: { provider: 'Audio source', until: 1794253200 } }] })]
  await show(true)
  expect(screen.getByText(/^Reintento a las/).parentElement).toHaveAttribute('title', expect.stringContaining('Todas las canciones de Audio source esperan · reintento a las'))
})

it('says no available upload when every match was gone, offers another video, and no Retry', async () => {
  jobs = [job({ expected_tracks: 1, imported_tracks: 0, state: 'fallido', items: [{ ...item, stage: 'fetch', detail: { ...item.detail, failedStage: 'fetch', candidatesTried: 3 } }] })]
  await show()
  const row = within(screen.getByRole('article', { name: 'Chladni Figures' }))
  expect(row.getByText('Ningún video disponible')).toBeInTheDocument()
  expect(row.queryByText(/de 1 falló/)).toBeNull()
  expect(row.queryByRole('button', { name: 'Ver 1' })).toBeNull()
  expect(row.queryByRole('button', { name: 'Reintentar' })).toBeNull()
  expect(row.getByRole('button', { name: 'Elegir otro video' })).toBeEnabled()
})
