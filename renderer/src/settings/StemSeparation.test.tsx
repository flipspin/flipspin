import { installTestClock, waitForClock as waitFor } from '../test/test-clock'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fixture from '../../../contracts/wire/server-config.json'
import { DataProvider, queryKeys } from '../data'
import { installFakeSettings, type FakeSettings, type RecordedRequest, type ResponseSpec } from './test-support'
import { summaryFixture } from './background/fixtures.testdata'
import { SettingsPage } from './SettingsPage'
import type { ServerConfig } from './config'
import type { Split } from './splitDeletes'

installTestClock()


let fake: FakeSettings | undefined
let client: QueryClient
const INITIAL: Split[] = [
  { album: 'Gawk', file: 'Alien Blues.mp3', title: 'Alien Blues', artist: 'Vundabar', albumTitle: 'Gawk', createdAt: new Date().toISOString(), stale: false, sizeBytes: 18_000_000 },
  { album: 'Braille', file: 'Tecate Freestyle.mp3', title: 'Tecate Freestyle', artist: 'LNG/SHT', albumTitle: 'Braille', createdAt: '2026-10-09T12:00:00', stale: true, sizeBytes: 22_000_000 },
]
afterEach(() => { fake?.restore(); client?.clear();  })

async function setup(options: { splits?: Split[]; on?: boolean; locked?: boolean; respond?: (r: RecordedRequest) => ResponseSpec | undefined } = {}) {
  const config = structuredClone(fixture) as ServerConfig
  const row = config.groups.flatMap(g => g.settings).find(s => s.key === 'KROBI_STEMS_BACKGROUND')!
  row.value = options.on ?? false
  if (options.locked) { row.source = 'env'; row.editable = false }
  const compute = summaryFixture()
  compute.kinds.find(kind => kind.kind === 'stems')!.policy.libraryPass = options.on ? 'auto' : 'ask'
  let splits = options.splits ?? [...INITIAL]
  fake = installFakeSettings({ respond: r => {
    const custom = options.respond?.(r)
    if (custom) return custom
    if (r.pathname === '/api/compute/summary') return { status: 200, json: compute }
    if (r.pathname === '/api/compute/kinds/stems' && r.method === 'PUT') { Object.assign(compute.kinds[1].policy, r.body); return { status: 200, json: compute.kinds[1].policy } }
    if (r.pathname === '/api/me') return { status: 200, json: { isOwner: true, role: 'owner', source: 'token' } }
    if (r.pathname === '/api/server/storage') return { status: 200, json: { disk: { total: 32e9, free: 20e9 }, music: 1e9, stems: 40_000_000, other: 0 } }
    if (r.pathname === '/api/status') return { status: 200, json: { app: 'krobi', restarting: false } }
    if (r.pathname === '/api/server/config') {
      if (r.method === 'PUT') { row.value = (r.body as { changes: Record<string, unknown> }).changes.KROBI_STEMS_BACKGROUND; row.source = 'app' }
      return { status: 200, json: config }
    }
    if (r.pathname === '/api/stems' && r.method === 'GET') return { status: 200, json: { splits } }
    if (r.method === 'DELETE' && r.pathname.startsWith('/api/stems')) {
      const count = splits.length
      splits = r.pathname === '/api/stems' ? [] : splits.filter(s => r.pathname !== `/api/stems/${encodeURIComponent(s.album)}/${encodeURIComponent(s.file)}`)
      return { status: 200, json: { removed: count - splits.length } }
    }
  } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<DataProvider queryClient={client}><SettingsPage initialSection="stems" surface="app" host={{ palette: 'paper', setPalette: vi.fn(), palettes: [], mode: 'light', setMode: vi.fn() }} /></DataProvider>)
  await waitFor(() => screen.getByRole('region', { name: 'Canciones con stems' }))
  if (options.splits?.length === 0) await waitFor(() => screen.getByText('Ninguna todavía'))
  else await waitFor(() => screen.getByText(`${options.splits?.length ?? 2} canciones`))
  return view
}
const deletes = () => fake!.requests.filter(r => r.method === 'DELETE')
const card = () => screen.getByRole('region', { name: 'Canciones con stems' })
const remove = (all: boolean) => {
  fireEvent.click(all ? screen.getByRole('button', { name: 'Eliminar todos' }) : screen.getByRole('button', { name: 'Eliminar stems de Alien Blues' }))
  if (all) fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Eliminar todos' }))
}
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

describe('Addons Stems', () => {
  it('bounds a 220-song fixture to six rows, sorts newest first and keeps the fixed body on every page', async () => {
    const splits = Array.from({ length: 220 }, (_, i) => ({ ...INITIAL[0], file: `song-${i}.mp3`, title: `Song ${i}`, createdAt: new Date(2026, 0, i + 1).toISOString() }))
    await setup({ splits })
    const table = within(card()).getByRole('table')
    const body = within(table).getByRole('rowgroup')
    expect(body).toHaveStyle({ height: '228px' })
    expect(within(body).getAllByRole('row')).toHaveLength(6)
    expect(within(body).getAllByRole('row')[0]).toHaveTextContent('Song 219')
    expect(within(table).getByRole('columnheader', { name: 'Separada' })).toHaveAttribute('aria-sort', 'descending')
    expect(within(card()).getByText('1–6 de 220')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Página 37' }))
    expect(within(body).getAllByRole('row')).toHaveLength(4)
    expect(within(card()).getByText('217–220 de 220')).toBeInTheDocument()
    expect(body).toHaveStyle({ height: '228px' })
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Anterior' }))
    expect(within(body).getAllByRole('row')).toHaveLength(6)
    expect(within(card()).getByText('211–216 de 220')).toBeInTheDocument()
  })
  it('searches title, artist and album without accents, resets pagination and clears no results', async () => {
    await setup()
    const search = within(card()).getByRole('searchbox', { name: 'Buscar canción, artista o álbum' })
    for (const term of ['ALIEN', 'vundábar', 'gawk']) {
      fireEvent.change(search, { target: { value: term } })
      expect(within(card()).getByText('1 canción')).toBeInTheDocument()
      expect(within(card()).getByText('Alien Blues')).toBeInTheDocument()
      expect(within(card()).queryByText('Tecate Freestyle')).not.toBeInTheDocument()
    }
    fireEvent.change(search, { target: { value: 'missing' } })
    expect(within(card()).getByText('0 canciones')).toBeInTheDocument()
    expect(within(card()).getByText('No hay canciones que coincidan.')).toBeInTheDocument()
    expect(within(card()).getByRole('rowgroup')).toHaveStyle({ height: '228px' })
    fireEvent.click(screen.getByRole('button', { name: 'Limpiar búsqueda' }))
    expect(search).toHaveValue('')
    expect(within(card()).getByText('2 canciones')).toBeInTheDocument()
  })
  it('shows each song size and sums all splits independently of storage and search', async () => {
    await setup({ respond: r => r.pathname === '/api/server/storage' ? { status: 200, json: { disk: { total: 32e9, free: 20e9 }, music: 1e9, stems: 99_000_000, other: 0 } } : undefined })
    const rows = within(card()).getAllByRole('row').slice(1)
    expect(within(rows[0]).getAllByRole('cell')[4]).toHaveTextContent('18 MB')
    expect(within(rows[1]).getAllByRole('cell')[4]).toHaveTextContent('22 MB')
    expect(within(card()).getByText('2 · 40 MB')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'alien' } })
    expect(within(card()).getByText('2 · 40 MB')).toBeInTheDocument()
    expect(within(card()).getAllByRole('row')).toHaveLength(2)
  })
  it('sums sizes across pages', async () => {
    const splits = Array.from({ length: 7 }, (_, i) => ({ ...INITIAL[0], file: `song-${i}.mp3`, sizeBytes: (i + 1) * 1_000_000 }))
    await setup({ splits })
    expect(within(card()).getByText('7 · 28 MB')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Página 2' }))
    expect(within(card()).getByText('7 · 28 MB')).toBeInTheDocument()
  })
  it('updates the size sum during a pending deletion and restores it on undo', async () => {
    await setup()
    vi.useFakeTimers()
    remove(false)
    expect(within(card()).getByText('1 · 22 MB')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }))
    expect(within(card()).getByText('2 · 40 MB')).toBeInTheDocument()
  })
  it('requires delete-all confirmation, supports cancel and deletes the entire list under a search', async () => {
    await setup()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'alien' } })
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar todos' }))
    const dialog = screen.getByRole('dialog', { name: 'Eliminar todos los stems' })
    expect(within(dialog).getByText('Se eliminarán los stems de 2 canciones. Las canciones se quedan.')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(deletes()).toHaveLength(0)
    vi.useFakeTimers()
    remove(true)
    expect(within(card()).getByText('Ninguna todavía')).toBeInTheDocument()
    expect(within(card()).getByText('0 · 0 B')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }))
    expect(within(card()).getByText('Alien Blues')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    expect(within(card()).getByText('Tecate Freestyle')).toBeInTheDocument()
    await advance(7000)
    expect(deletes()).toHaveLength(0)
  })
  it('renders the approved copy, count, muted albums, compact dates and tooltips', async () => {
    await setup({ on: true })
    expect(within(card()).getByText('2 canciones')).toBeInTheDocument()
    expect(within(card()).getByText('Gawk')).toBeInTheDocument()
    expect(within(card()).getByText('hoy')).toBeInTheDocument()
    expect(within(card()).getByText('9 oct')).toBeInTheDocument()
    expect(within(card()).getAllByTitle('Elimina los stems; la canción se queda')).toHaveLength(2)
    expect(within(card()).queryByText('Trabajos')).not.toBeInTheDocument()
  })
  it('renders the empty state with zero and no delete-all action', async () => {
    await setup({ splits: [] })
    expect(within(card()).getByText('0 canciones')).toBeInTheDocument()
    expect(within(card()).getByText('Ninguna todavía')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Eliminar todos' })).not.toBeInTheDocument()
  })
  it.each([false, true])('check 9: %s delete hides immediately and sends DELETE only at 6000 ms', async all => {
    await setup()
    vi.useFakeTimers()
    remove(all)
    expect(within(card()).queryByText('Alien Blues')).not.toBeInTheDocument()
    expect(within(card()).getByText(all ? '0 canciones' : '1 canción')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deshacer' })).toBeInTheDocument()
    expect(deletes()).toHaveLength(0)
    await advance(5999)
    expect(deletes()).toHaveLength(0)
    await advance(1)
    expect(deletes()).toHaveLength(1)
    expect(deletes()[0].pathname).toBe(all ? '/api/stems' : '/api/stems/Gawk/Alien%20Blues.mp3')
    expect(screen.queryByRole('button', { name: 'Deshacer' })).not.toBeInTheDocument()
  })
  it.each([false, true])('check 9: undo of %s delete restores the list and never sends DELETE', async all => {
    await setup()
    vi.useFakeTimers()
    remove(all)
    await advance(5999)
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }))
    expect(within(card()).getByText('Alien Blues')).toBeInTheDocument()
    expect(within(card()).getByText('2 canciones')).toBeInTheDocument()
    await advance(12_000)
    expect(deletes()).toHaveLength(0)
  })
  it('cancels the previous deletion when another delete replaces its undo toast', async () => {
    await setup()
    vi.useFakeTimers()
    remove(false)
    await advance(3000)
    fireEvent.click(screen.getByRole('button', { name: 'Eliminar stems de Tecate Freestyle' }))
    expect(within(card()).getByText('Alien Blues')).toBeInTheDocument()
    await advance(6000)
    expect(deletes()).toHaveLength(1)
    expect(deletes()[0].pathname).toContain('Tecate%20Freestyle.mp3')
  })
  it('keeps a pending row hidden across refetch and section navigation', async () => {
    const view = await setup()
    vi.useFakeTimers()
    remove(false)
    await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.stems.splits() }) })
    expect(within(card()).queryByText('Alien Blues')).not.toBeInTheDocument()
    view.rerender(<DataProvider queryClient={client}><SettingsPage initialSection="stems" surface="app" host={{ palette: 'paper', setPalette: vi.fn(), palettes: [], mode: 'light', setMode: vi.fn() }} /></DataProvider>)
    expect(within(card()).queryByText('Alien Blues')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }))
    expect(within(card()).getByText('Alien Blues')).toBeInTheDocument()
    await advance(7000)
    expect(deletes()).toHaveLength(0)
  })
  it('cancels a deletion when Settings closes during the undo window', async () => {
    const view = await setup()
    vi.useFakeTimers()
    remove(true)
    view.unmount()
    await advance(7000)
    expect(deletes()).toHaveLength(0)
  })
  it('restores rows and shows the app error toast when DELETE fails', async () => {
    await setup({ respond: r => r.method === 'DELETE' ? { status: 403, json: { detail: 'forbidden' } } : undefined })
    vi.useFakeTimers()
    remove(false)
    await advance(6000)
    expect(within(card()).getByText('Alien Blues')).toBeInTheDocument()
    expect(screen.getByText('No se pudieron eliminar los stems. Vuelve a intentarlo.')).toBeInTheDocument()
  })
})


it('moves automatic separation to Stems and links its current placement to Helpers', async () => {
  await setup({ on: true })
  const toggle = screen.getByRole('switch', { name: 'Separar automáticamente' })
  expect(toggle).toBeChecked()
  fireEvent.click(toggle)
  await waitFor(() => expect(fake!.requests.find(request => request.pathname === '/api/compute/kinds/stems' && request.method === 'PUT')?.body).toEqual({ libraryPass: 'ask' }))
  expect(await waitFor(() => screen.getByText('Solo equipos auxiliares · Helper computer'))).toBeInTheDocument()
  await waitFor(() => expect(toggle).not.toBeChecked())
  fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Equipos auxiliares' }))
  expect(await waitFor(() => screen.getByRole('heading', { level: 2, name: /Equipos auxiliares/ }))).toBeInTheDocument()
})
