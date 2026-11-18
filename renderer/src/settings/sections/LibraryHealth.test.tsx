import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { DataProvider } from '../../data'
import { SettingsProvider, type SettingsContextValue } from '../context'
import { LibraryHealth } from './LibraryHealth'
import { fixNowCount, type LibraryHealthData } from '../healthData'
import { installFakeSettings, type FakeSettings } from '../test-support'
import wire from '../../../../contracts/wire/library-health.json'

const state = vi.hoisted(() => ({ offline: false }))
vi.mock('../../offline/useOffline', () => ({ useOffline: () => state.offline }))
let fake: FakeSettings | undefined
let client: QueryClient
const go = vi.fn()
const match = vi.fn()
const bulk = vi.fn()
const info = vi.fn()
afterEach(() => { fake?.restore(); client?.clear(); vi.clearAllMocks(); state.offline = false })

function issues(): LibraryHealthData {
  const data = structuredClone(wire) as LibraryHealthData
  for (const check of data.checks) {
    check.state = 'ready'
    check.reason = null
    check.count = check.id === 'missing' ? 3 : 1
  }
  const missing = data.checks.find(c => c.id === 'missing')!
  missing.folders = 1; missing.topFolder = 'Music/Old Rips'
  return data
}
function mount(data = issues(), options: { admin?: boolean; error?: boolean } = {}) {
  fake = installFakeSettings({ respond: request => {
    if (request.pathname === '/api/library/health') return options.error ? { status: 503, json: { detail: 'offline' } } : { status: 200, json: data }
    return undefined
  } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const context = { admin: options.admin ?? true, go, host: { openHealthMatch: match, openHealthBulkTags: bulk, openEstimateInfo: info } } as unknown as SettingsContextValue
  return render(<DataProvider queryClient={client}><SettingsProvider value={context}><LibraryHealth /></SettingsProvider></DataProvider>)
}

it('draws the issues, numeric facts and their sources', async () => {
  mount()
  expect(await screen.findByRole('region', { name: 'Resolver ahora' })).toHaveTextContent('3')
  expect(screen.getByText('1 por resolver · 4 sugerencias')).toBeInTheDocument()
  expect(screen.getByText('Music/Old Rips')).toBeInTheDocument()
  const row = screen.getByRole('button', { name: /Archivos faltantes/ })
  expect(row.title).toContain('missing-files.known')
  expect(row.title).toContain('2026-11-01')
  expect(fixNowCount(issues())).toBe(3)
})

it('shows all clear and hides zero suggestions and badge', async () => {
  const data = issues()
  data.checks.find(c => c.id === 'missing')!.count = 0
  data.checks.find(c => c.id === 'duplicates')!.count = 0
  mount(data)
  expect(await screen.findByRole('region', { name: 'Todo en orden' })).toHaveTextContent('revisado hace')
  expect(screen.getByText('todo en orden · 3 sugerencias')).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Resolver ahora' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Posibles duplicados/ })).not.toBeInTheDocument()
  expect(fixNowCount(data)).toBe(0)
})

it('reports an unavailable source in words and never claims all clear', async () => {
  const data = issues()
  const missing = data.checks.find(c => c.id === 'missing')!
  missing.count = null; missing.state = 'unavailable'; missing.reason = 'source-failed'
  mount(data)
  const row = await screen.findByRole('button', { name: /Archivos faltantes/ })
  expect(row).toBeDisabled()
  expect(row).toHaveTextContent('No disponible')
  expect(row.title).toContain('source-failed')
  expect(screen.queryByRole('region', { name: 'Todo en orden' })).not.toBeInTheDocument()
  expect(fixNowCount(data)).toBe(0)
})

it.each([['Archivos faltantes', 'missing'], ['Posibles duplicados', 'duplicates']])('routes %s to the existing section', async (name, id) => {
  mount()
  await userEvent.click(await screen.findByRole('button', { name: new RegExp(name) }))
  expect(go).toHaveBeenCalledWith(id)
})

it('opens Review estimates', async () => {
  mount()
  await userEvent.click(await screen.findByRole('button', { name: /Estimados por confirmar/ }))
  expect(go).toHaveBeenCalledWith('estimates')
})

it('opens MusicBrainz matching through the host with an album scope', async () => {
  mount()
  await userEvent.click(await screen.findByRole('button', { name: /Álbumes sin coincidencia/ }))
  expect(match).toHaveBeenCalledWith({ albumKey: 'Album' })
})

it('lets the owner choose an unmatched album when several need matching', async () => {
  const data = issues()
  data.checks.find(c => c.id === 'unmatched')!.albumKeys = ['Album', 'Other']
  mount(data)
  await userEvent.click(await screen.findByRole('button', { name: /Álbumes sin coincidencia/ }))
  await userEvent.click(screen.getByRole('button', { name: 'Other' }))
  expect(match).toHaveBeenCalledWith({ albumKey: 'Other' })
})

it('opens remaster songs and the complete bulk selection through the host', async () => {
  const data = issues()
  const remaster = data.checks.find(c => c.id === 'remaster')!
  remaster.tracks = [...remaster.tracks!, { relPath: 'Album/other.mp3', title: 'Other (Remastered)', artist: 'Artist' }]
  mount(data)
  await userEvent.click(await screen.findByRole('button', { name: /Sufijo de remasterización/ }))
  await userEvent.click(screen.getByRole('button', { name: /Song \(Remastered 2009\)/ }))
  expect(info).toHaveBeenCalledWith('Album/song.mp3')
  await userEvent.click(screen.getByRole('button', { name: 'Editar todas' }))
  expect(bulk).toHaveBeenCalledWith(['Album/song.mp3', 'Album/other.mp3'])
})

it('shows a loading skeleton', () => {
  mount()
  expect(screen.getByRole('status', { name: 'Cargando salud de la biblioteca' })).toBeInTheDocument()
})

it('shows an error and retries', async () => {
  mount(issues(), { error: true })
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cargar')
  const before = fake!.requests.filter(r => r.pathname === '/api/library/health').length
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
  expect(fake!.requests.filter(r => r.pathname === '/api/library/health').length).toBeGreaterThan(before)
})

it('shows no access to members without querying owner facts', () => {
  mount(issues(), { admin: false })
  expect(screen.getByText('Sin acceso')).toBeInTheDocument()
  expect(fake!.requests.filter(r => r.pathname === '/api/library/health')).toHaveLength(0)
})

it('shows nest offline without fetching', () => {
  state.offline = true
  mount()
  expect(screen.getByText('Nido sin conexión')).toBeInTheDocument()
  expect(fake!.requests.filter(r => r.pathname === '/api/library/health')).toHaveLength(0)
})

it.each([[1, 'ok'], [3, 'warn'], [8, 'bad'], [null, 'bad']] as const)('uses the backup age status for %s days', async (days, tone) => {
  const data = issues()
  data.stats.lastBackupAt = { value: days === null ? null : new Date(Date.now() - days * 86400_000).toISOString(), source: { store: 'backups.latest', asOf: new Date().toISOString() }, state: 'ready' }
  const view = mount(data)
  await screen.findByRole('region', { name: 'Resolver ahora' })
  expect(view.container.querySelector('.lh-stat:last-child .settings-dotw')).toHaveClass(`settings-dotw--${tone}`)
})
