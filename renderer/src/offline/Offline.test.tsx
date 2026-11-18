import contract from "../../../contracts/offline.json"
import { offlineReason } from './useOfflineStorage'
import { snapshotKind } from "./snapshots"
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { onlineManager } from '@tanstack/react-query'
import { setFakeBridgeForTest } from '../bridge'
import { DataProvider, useLibraryAlbums } from '../data'
import { serverStatus } from '../settings/test-support'
import type { KrobiBridge, ServerConnection, ServerStatus, LibrarySnapshot } from '../lib/ipc'
import { OfflineBanner } from './OfflineBanner'
import { OfflineLibraryProvider } from './OfflineLibrary'
import { useOffline } from './useOffline'
import { setForcedOffline } from './mode'
import { OutboxJobs } from './OutboxJobs'
import AlbumTrackRow from '../albums/AlbumTrackRow'

let restore: (() => void) | undefined
const listeners = new Map<string, Set<(value: unknown) => void>>()
let forced = false
let status: ServerStatus
const at = Date.parse('2026-11-09T18:42:00Z') / 1000
const albums = [{ album: 'Night Music', path: '/music/Night Music', tracks: [
  { title: 'Local song', relPath: 'Night Music/local.mp3', path: '/music/Night Music/local.mp3', artist: 'Workshop', duration: 180 },
  { title: 'Remote song', relPath: 'Night Music/remote.mp3', path: '/music/Night Music/remote.mp3', artist: 'Workshop', duration: 190 },
] }]
const emit = (channel: string, value: unknown) => { for (const fn of listeners.get(channel) ?? []) fn(value) }
function install(state: ServerConnection['state']) {
  status = serverStatus({ mode: 'external', baseUrl: 'http://nido.test', connection: { state, since: 0, attempt: 1, lastError: null, checks: [] } })
  const fake = {
    invoke: vi.fn(async (channel: string, request?: { forced?: boolean; kind?: string }) => {
      if (channel === 'server:get-status') return status
      if (channel === 'offline:mode') {
        if (request?.forced !== undefined) { forced = request.forced; emit('offline:changed', null) }
        return { forced }
      }
      if (channel === 'offline:sync') return { ok: true }
      if (channel === 'offline:snapshot') return { kind: request?.kind, body: JSON.stringify(albums), fetchedAt: at, etag: '"one"' } as LibrarySnapshot
      if (channel === 'offline:status') return { pins: 1, files: 1, bytes: 1, tracks: [{ key: 'Night Music/local.mp3', state: 'descargado', verifiedAt: at, pool: 'offline', bytes: 1, etag: null, lastPlayedAt: null, error: null }] }
      if (channel === 'offline:outbox') return [{ id: 'conflict', idempotencyKey: 'conflict', intent: 'playlist-edit', createdAt: at, state: 'failed', attempts: 5, body: JSON.stringify({ tracks: [{ title: 'Local version' }], base: { tracks: [] } }), lastError: '412:' + JSON.stringify({ detail: { current: { tracks: [{ title: 'Nest version' }] } } }) }]
      throw new Error(`Unexpected IPC: ${channel}`)
    }),
    on: (channel: string, fn: (value: unknown) => void) => {
      const set = listeners.get(channel) ?? new Set()
      listeners.set(channel, set); set.add(fn)
      return () => set.delete(fn)
    },
  }
  restore = setFakeBridgeForTest(fake as unknown as KrobiBridge)
  return fake
}
afterEach(() => { restore?.(); listeners.clear(); forced = false; vi.restoreAllMocks() })
function Library() {
  const data = useLibraryAlbums()
  const offline = useOffline()
  return <><OfflineBanner /><span>{offline ? 'offline-view' : 'online-view'}</span><ul>
    {data.data?.flatMap(album => album.tracks).map((track, index) => <AlbumTrackRow key={track.path} track={track} index={index} onPlay={() => {}} album={{ album: 'Night Music', artist: 'Workshop' }} number={index + 1} language={undefined} selected={false} isActive={false} searchQuery="" highlightMatches={undefined} onSelect={undefined} onOpenAlbum={undefined} onOpenArtist={undefined} playList={albums[0].tracks} playAlbum={undefined} onDownload={undefined} onOpenAnalysis={undefined} onContextMenu={undefined} />)}
  </ul></>
}
it('renders the offline library snapshot, greys unavailable songs, and shows the saved copy time', async () => {
  const fake = install('unreachable')
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Must not request the nest'))
  const { container } = render(<DataProvider><OfflineLibraryProvider albums={albums}><Library /></OfflineLibraryProvider></DataProvider>)
  await screen.findByText('Local song')
  expect(await screen.findByRole('img', { name: 'No disponible sin conexión' })).toBeVisible()
  await waitFor(() => expect(container.querySelectorAll('.is-offline-unavailable')).toHaveLength(1))
  const unavailable = container.querySelector('.is-offline-unavailable') as HTMLElement
  expect(unavailable).toHaveTextContent('Remote song')
  expect(unavailable.querySelectorAll('.acquire-row-end')).toHaveLength(1)
  expect(within(unavailable).getByRole('img', { name: 'No disponible sin conexión' })).toBeVisible()
  expect(unavailable.querySelector('.acquire-status-slot')).toBeNull()
  expect(unavailable.querySelector('.acquire-row-end button')).toBeNull()
  expect(within(unavailable).getByRole('button', { name: 'Reproducir Remote song' })).toBeDisabled()
  expect(container.querySelector('.offline-song-status')).toBeNull()
  const time = new Date(at * 1000).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', hour12: false })
  expect(await screen.findByText(`copia de las ${time}`)).toBeVisible()
  expect(fake.invoke).toHaveBeenCalledWith('offline:snapshot', { kind: 'listing' })
  expect(fetch).not.toHaveBeenCalled()
})
it('forced mode behaves offline while the shell remains connected; NeedsAuth alone is not offline', async () => {
  install('connected')
  render(<DataProvider><Library /></DataProvider>)
  await screen.findByText('online-view')
  await act(async () => { await setForcedOffline(true) })
  expect(screen.getByText('Modo sin conexión')).toBeVisible()
  expect(screen.getByText('offline-view')).toBeVisible()
  expect(status.connection.state).toBe('connected')
  expect(onlineManager.isOnline()).toBe(false)
  await act(async () => { await setForcedOffline(false); status = { ...status, connection: { ...status.connection, state: 'needs-auth' } }; emit('server:status-changed', status) })
  expect(screen.getByText('online-view')).toBeVisible()
  expect(screen.queryByText('Modo sin conexión')).toBeNull()
  expect(screen.queryByText(/Sin conexión con/)).toBeNull()
})
it('surfaces 412 and keeps the local and nest playlist versions visible', async () => {
  install('unreachable')
  render(<OutboxJobs />)
  expect(await screen.findByText('1 cambios esperan al nido')).toBeVisible()
  fireEvent.click(screen.getByText('Ver ambas versiones'))
  expect(screen.getByText('Local version')).toBeVisible()
  expect(screen.getByText('Nest version')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull()
})

it('reads the shared snapshot contract including Home', () => {
  const paths = ['/api/listar-albums-con-metadata', '/api/me/library', '/api/playlists', '/api/playlists/favorites', '/api/me/home']
  expect(paths.map(snapshotKind)).toEqual(contract.snapshotKinds)
})
it('allows online browsing without creating an account snapshot', async () => {
  const fake = install('connected')
  const original = fake.invoke.getMockImplementation()!
  fake.invoke.mockImplementation(async (channel, request) => {
    if (channel === 'offline:snapshot') throw new Error('account-required')
    return original(channel, request)
  })
  const { snapshotResponse } = await import('./snapshots')
  // Let the connection adapter receive the signed-out shell's connected state.
  render(<DataProvider><span /></DataProvider>)
  await act(async () => {})
  expect(await snapshotResponse('/api/listar-albums-con-metadata')).toBeNull()
  expect(onlineManager.isOnline()).toBe(true)
})

it('uses live playlist summaries online and labels saved summaries with their timestamp', async () => {
  const fake = install('connecting')
  const { snapshotResponse } = await import('./snapshots')
  render(<DataProvider><span /></DataProvider>)
  await act(async () => {})
  expect((await snapshotResponse('/api/playlists'))?.headers['x-krobi-snapshot-at']).toBe(String(at))
  await act(async () => {
    status = { ...status, connection: { ...status.connection, state: 'connected' } }
    emit('server:status-changed', status)
  })
  fake.invoke.mockClear()
  expect(await snapshotResponse('/api/playlists')).toBeNull()
  expect(fake.invoke).not.toHaveBeenCalledWith('offline:snapshot', { kind: 'playlists' })
})

it('discards a pending playlist snapshot when the connection returns during the read', async () => {
  const fake = install('connecting')
  const { snapshotResponse } = await import('./snapshots')
  render(<DataProvider><span /></DataProvider>)
  await act(async () => {})
  let finish!: (row: LibrarySnapshot) => void
  fake.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = snapshotResponse('/api/playlists')
  await act(async () => {
    status = { ...status, connection: { ...status.connection, state: 'connected' } }
    emit('server:status-changed', status)
    finish({ kind: 'playlists', body: '[]', fetchedAt: at, etag: 'old' })
  })
  expect(await pending).toBeNull()
})

it('reuses the shared missing-file state for unavailable pin entries', () => {
  for (const entry of contract.missingFiles.cases) {
    if (entry.out !== 'ya no está en el nido') continue
    expect(entry.out).toBe(contract.missingFiles.state)
    expect(offlineReason({ key: 'A/one.mp3', state: entry.out, pool: 'offline', bytes: 0, verifiedAt: null, etag: null, lastPlayedAt: null, error: null })).toBe('No longer on the nest')
  }
})
