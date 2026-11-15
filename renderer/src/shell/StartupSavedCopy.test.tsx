import { installTestClock, waitForClock as waitFor } from '../test/test-clock'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Gate from './Gate'
import App from './App'
import { DataProvider, useLibraryAlbums } from '../data'
import { installFakeSettings, serverStatus, type FakeSettings } from '../settings/test-support'
import type { ServerConnection } from '../lib/ipc'
import { recordLocalPlay } from '@lib/playHistory'
import { useNestStatus } from './ServerBadge'
import { setForcedOffline } from '../offline/mode'
import { ConnectionBannerDetails } from '../connection/ConnectionBannerDetails'
import { ConnectionStatusList } from '../connection/StatusList'
import { snapshotResponse } from '../offline/snapshots'

installTestClock()


const at = new Date(2026, 10, 9, 18, 42).getTime() / 1000
const albums = (song: string) => [{ album: 'Saved album', artist: 'Workshop', path: '/music/Saved album', tracks: [{ title: song, path: '/music/Saved album/song.mp3', relPath: 'Saved album/song.mp3', artist: 'Workshop', duration: 180 }] }]
const connection = (state: ServerConnection['state']): ServerConnection => ({ state, since: Date.now(), attempt: 1, lastError: state === 'unreachable' ? 'connection-lost' : null, checks: [
  { id: 'this-computer', status: 'ok', detail: '192.0.2.2' },
  { id: 'route', status: 'warn', detail: '192.0.2.10' },
  { id: 'krobi', status: 'idle', detail: null },
] })
let fake: FakeSettings | undefined
beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('krobi.bottomBarDrawerOpen', '0')
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue()
})
afterEach(() => { fake?.restore(); vi.restoreAllMocks() })

function fixture(copy = true, state: ServerConnection['state'] = 'connecting') {
  let live = false
  fake = installFakeSettings({
    status: serverStatus({ mode: 'external', name: 'Nido de casa', connection: connection(state) }),
    snapshot: kind => {
      if (live) return undefined // The fresh response now comes from the network.
      if (!copy) return null
      return { kind, body: JSON.stringify(kind === 'home' ? { albums: albums('Saved home song'), library: { tracks: [] }, playlists: [] } : kind === 'listing' ? albums('Saved listing song') : kind === 'library' ? { tracks: [] } : []), fetchedAt: kind === 'home' ? at : at - 60, etag: '"saved"' }
    },
    probe: address => ({ ok: true, url: address, handshake: { app: 'krobi', instanceId: 'lib-1', version: '1', isInit: true, authMethods: ['token'], name: 'Nido de casa' } }),
    respond: r => ({ status: 200, json: r.pathname === '/api/me/home' ? { albums: albums('Live home song'), library: { tracks: [] }, playlists: [] } : r.pathname === '/api/listar-albums-con-metadata' ? albums('Live listing song') : r.pathname === '/api/playlists' ? [] : r.pathname === '/api/me' ? { id: 'u-me', source: 'token', isOwner: true } : {} }),
  })
  return (state: ServerConnection['state']) => {
    live = state === 'connected'
    act(() => fake!.emitServerStatus(serverStatus({ mode: 'external', name: 'Nido de casa', connection: connection(state) })))
  }
}

it('opens on the saved copy without a wait screen; Home timestamps both shelves, then replaces it with live rows', async () => {
  const push = fixture()
  recordLocalPlay(albums('Saved home song')[0].tracks[0])
  const { container } = render(<Gate><App /></Gate>)
  const waits: string[] = []
  const observer = new MutationObserver(() => { if (container.querySelector('.ks-wait')) waits.push(container.textContent ?? '') })
  observer.observe(container, { childList: true, subtree: true })
  await waitFor(() => screen.getAllByText('Saved home song'))
  expect(waits).toEqual([])
  expect(screen.queryByRole('heading', { name: /Conectando con/ })).not.toBeInTheDocument()
  const time = new Date(at * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', hour12: false })
  const ages = screen.getAllByText(`copia de las ${time}`)
  expect(ages).toHaveLength(2)
  for (const age of ages) {
    expect(age).toHaveClass('ak-copy-age')
    expect(age).toHaveAttribute('title', 'Copia de tu biblioteca guardada en este equipo')
    expect(age.closest('section')?.querySelector('h3')).toHaveTextContent(/Recién agregado|Más escuchadas/)
  }
  expect(fake!.invokedWith('offline:snapshot')).toContainEqual({ kind: 'home' })
  expect(fake!.requests.filter(r => ['/api/listar-albums-con-metadata', '/api/me/home', '/api/playlists'].includes(r.pathname))).toHaveLength(0)
  expect(screen.queryByText(/Aún no hay álbumes|Aún no has escuchado/)).toBeNull()
  push('connected')
  await waitFor(() => screen.getAllByText('Live home song'))
  await waitFor(() => expect(screen.queryAllByText(/copia de las/)).toHaveLength(0))
  expect(fake!.requests.some(r => r.pathname === '/api/me/home')).toBe(true)
  expect(fake!.requests.some(r => r.pathname === '/api/listar-albums-con-metadata')).toBe(true)
  expect(screen.queryByText('Saved home song')).toBeNull()
  observer.disconnect()
})

it('without a copy waits with the cached nest name and no empty-library claims', async () => {
  fixture(false)
  render(<Gate><App /></Gate>)
  expect(await waitFor(() => screen.getByRole('heading', { name: 'Conectando con Nido de casa…' }))).toBeVisible()
  expect(screen.queryByText('Recién agregado')).toBeNull()
  expect(fake!.requests.filter(r => ['/api/listar-albums-con-metadata', '/api/me/home', '/api/playlists'].includes(r.pathname))).toHaveLength(0)
})

it('wrong-nest never opens on a copy, and removes one already displayed', async () => {
  fixture(true, 'wrong-nest')
  const view = render(<Gate><p>Saved library</p></Gate>)
  await waitFor(() => screen.getByRole('button', { name: 'Crear nido aquí' }))
  expect(screen.queryByText('Saved library')).toBeNull()
  expect(fake!.invokedWith('offline:snapshot')).toHaveLength(0)
  view.unmount()
  fake!.restore()
  const transition = fixture()
  render(<Gate><App /></Gate>)
  await waitFor(() => screen.getAllByText('Saved home song'))
  transition('wrong-nest')
  await waitFor(() => screen.getByRole('button', { name: 'Crear nido aquí' }))
  expect(screen.queryByText('Saved home song')).toBeNull()
})

it('fills a paused TanStack query from the copy and refetches the live listing on connected', async () => {
  const push = fixture()
  function Listing() { const query = useLibraryAlbums(); return <p>{query.fetchStatus}:{query.data?.[0]?.tracks[0]?.title}</p> }
  render(<DataProvider><Listing /></DataProvider>)
  expect(await waitFor(() => screen.getByText('paused:Saved listing song'))).toBeVisible()
  expect(fake!.requests.filter(r => ['/api/listar-albums-con-metadata', '/api/me/home', '/api/playlists'].includes(r.pathname))).toHaveLength(0)
  push('connected')
  expect(await waitFor(() => screen.getByText('idle:Live listing song'))).toBeVisible()
  expect(fake!.requests.filter(r => r.pathname === '/api/listar-albums-con-metadata')).toHaveLength(1)
})

it('the network banner opens ConnectionDetails in the shared Popover; forced mode hides Detalles and owns the account line', async () => {
  fixture(true, 'unreachable')
  render(<DataProvider><App /></DataProvider>)
  const button = await waitFor(() => screen.getByRole('button', { name: 'Detalles' }))
  expect(screen.getByText('Sin conexión con Nido de casa')).toBeVisible()
  expect(button.querySelector('svg')).toHaveAttribute('width', '15')
  fireEvent.click(button)
  const popover = screen.getByRole('dialog', { name: 'Detalles de la conexión' })
  expect(popover).toHaveClass('k-popover')
  expect(within(popover).getByRole('heading', { name: 'Conexión con Nido de casa' })).toBeVisible()
  expect(within(popover).getByText('Equipo del nido')).toBeVisible()
  fireEvent.keyDown(document, { key: 'Escape' })
  await act(async () => { await setForcedOffline(true) })
  expect(screen.queryByRole('button', { name: 'Detalles' })).toBeNull()
  expect(screen.getAllByText('Modo sin conexión').length).toBeGreaterThanOrEqual(2)
})

it('the account line gives forced mode priority over a connected nest name', async () => {
  fixture(true, 'connected')
  function AccountLine() { return <p>{useNestStatus().label}</p> }
  render(<DataProvider><AccountLine /></DataProvider>)
  expect(await waitFor(() => screen.getByText('Nido de casa'))).toBeVisible()
  await act(async () => { await setForcedOffline(true) })
  expect(screen.getByText('Modo sin conexión')).toBeVisible()
  expect(screen.queryByText('Nido de casa')).toBeNull()
})

it.each(['light', 'dark', 'night'])('uses Paper tokens and follows %s mode inside the details portal', async mode => {
  const previous = document.documentElement.getAttribute('data-mode')
  document.documentElement.setAttribute('data-mode', mode)
  try {
    fixture(true, 'unreachable')
    render(<DataProvider><ConnectionBannerDetails /></DataProvider>)
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Detalles' })))
    const panel = screen.getByRole('dialog', { name: 'Detalles de la conexión' })
    expect(panel.querySelector('.ks-pop')).toHaveAttribute('data-profile', 'modern')
    expect(panel.querySelector('.ks-pop')).toHaveAttribute('data-theme', mode === 'light' ? 'light' : 'dark')
  } finally {
    if (previous === null) document.documentElement.removeAttribute('data-mode')
    else document.documentElement.setAttribute('data-mode', previous)
  }
})

it('calls a lost connection Sin respuesta even if an older shell sent an idle route row', () => {
  const lost = connection('unreachable')
  lost.checks[1].status = 'idle'
  render(<ConnectionStatusList connection={lost} />)
  expect(screen.getByText('Sin respuesta')).toBeVisible()
  expect(screen.queryByText('Conectando…')).toBeNull()
})

it('rejects late local reads after wrong-nest and re-reads after the connection returns', async () => {
  let resolve!: (row: { kind: 'listing'; body: string; fetchedAt: number; etag: null }) => void
  let live = false
  fake = installFakeSettings({
    status: serverStatus({ connection: connection('connecting') }),
    snapshot: () => live ? undefined : new Promise(done => { resolve = done }),
  })
  render(<DataProvider><span /></DataProvider>)
  await act(async () => {})
  const pending = snapshotResponse('/api/listar-albums-con-metadata')
  live = true
  act(() => fake!.emitServerStatus(serverStatus({ connection: connection('connected') })))
  resolve({ kind: 'listing', body: JSON.stringify(albums('Late snapshot')), fetchedAt: at, etag: null })
  expect(await pending).toBeNull()
  live = false
  act(() => fake!.emitServerStatus(serverStatus({ connection: connection('connecting') })))
  const wrong = snapshotResponse('/api/listar-albums-con-metadata')
  act(() => fake!.emitServerStatus(serverStatus({ connection: connection('wrong-nest') })))
  resolve({ kind: 'listing', body: JSON.stringify(albums('Wrong nest copy')), fetchedAt: at, etag: null })
  expect(await wrong).toMatchObject({ ok: false, status: 503, body: JSON.stringify({ detail: 'wrong-nest' }) })
})
