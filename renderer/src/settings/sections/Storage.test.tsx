import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setFakeBridgeForTest } from '../../bridge'
import { resetApiClient } from '../../data'
import { serverStatus } from '../test-support'
import { ConfirmProvider } from '../../ui/confirm'
import type { KrobiBridge, OfflinePools, OfflineStatus } from '../../lib/ipc'
import { SettingsProvider, type SettingsContextValue } from '../context'
import { Storage } from './Storage'

let restore: () => void
let pools: OfflinePools
let status: OfflineStatus
let calls: { channel: string; request: unknown }[]
let listeners: Set<() => void>
let refuse = false
const context: SettingsContextValue = {
  surface: 'app', admin: false, me: null, meStatus: null, mePending: false, meError: null,
  refreshMe: () => {}, server: { kind: 'ready', value: null }, refreshServer: () => {}, go: () => {},
  host: { palette: 'paper', setPalette: () => {}, palettes: [], mode: 'light', setMode: () => {} },
}
beforeEach(() => {
  calls = []; listeners = new Set(); refuse = false
  pools = { offline: { bytes: 2.1e9, files: 412, location: '/Library/Krobi/Descargas' }, cache: { bytes: 640e6, files: 80, location: '/Caches/Krobi' }, cacheBudget: 2e9, pins: [{ id: 'album:a', kind: 'album', ref: 'a', tracks: ['a/one.mp3', 'a/two.mp3'] }] }
  status = { pins: 1, files: 412, bytes: 2.1e9, tracks: [] }
  restore = setFakeBridgeForTest({
    invoke: (async (channel: string, request: Record<string, unknown>) => {
      calls.push({ channel, request })
      if (channel === 'server:get-status') return serverStatus({ connection: { state: 'connected', since: 0, attempt: 1, lastError: null, checks: [] } })
      if (channel === 'offline:mode') return { forced: false }
      if (channel === 'offline:sync') return { ok: true }
      if (channel === 'offline:snapshot') return undefined
      if (channel === 'app:get-backend-origin') return { origin: 'http://storage.test' }
      if (channel === 'offline:status') return status
      if (channel === 'offline:pools') {
        if (request.action === 'clear-cache') pools = { ...pools, cache: { ...pools.cache, bytes: 0, files: 0 } }
        if (request.action === 'remove-downloads') { pools = { ...pools, pins: [], offline: { ...pools.offline, files: 0, bytes: 0 } }; status = { ...status, pins: 0, tracks: [] } }
        return pools
      }
      if (channel === 'offline:pin') {
        if (refuse) return { ok: false, reason: 'no-space' }
        const id = `${request.kind}:${request.ref}`
        pools = { ...pools, pins: [...pools.pins!.filter(pin => pin.id !== id), { id, kind: request.kind, ref: request.ref, tracks: (request.tracks as { key: string }[]).map(track => track.key) }] } as OfflinePools
        return { ok: true, pinId: id }
      }
      if (channel === 'offline:unpin') { pools = { ...pools, pins: pools.pins!.filter(pin => pin.id !== request.pinId) }; return { ok: true } }
      throw new Error(channel)
    }) as KrobiBridge['invoke'],
    on: ((_channel: string, listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }) as KrobiBridge['on'],
  })
  resetApiClient()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tracks: [{ relPath: 'a/one.mp3' }, { relPath: 'a/two.mp3' }], count: 2 })))
})
afterEach(() => { restore(); resetApiClient(); vi.unstubAllGlobals() })
async function show() {
  render(<ConfirmProvider><SettingsProvider value={context}><Storage /></SettingsProvider></ConfirmProvider>)
  await screen.findByText('412 canciones · 2,1 GB')
}
it('reads counts, bytes, cache budget and location from the fake bridge; updates on offline:changed', async () => {
  await show()
  expect(screen.getByText('640 MB de 2 GB')).toBeInTheDocument()
  expect(screen.getByText('/Library/Krobi/Descargas')).toBeInTheDocument()
  expect(screen.getByText('Al día')).toBeInTheDocument()
  expect(screen.getByRole('meter')).toHaveAttribute('value', '640000000')
  status = { ...status, tracks: [{ key: 'a/one.mp3', state: 'descargando', pool: 'offline', bytes: 0, error: null, etag: null, verifiedAt: null, lastPlayedAt: null }] }
  await act(async () => { listeners.forEach(listener => listener()) })
  expect(await screen.findByText('Descargando')).toBeInTheDocument()
  expect(calls).toContainEqual({ channel: 'offline:status', request: { keys: [] } })
})
it('starts off, pins the whole personal library, and unpins it on disabling', async () => {
  await show()
  const toggle = screen.getByRole('switch', { name: 'Descargas automáticas' })
  expect(toggle).not.toBeChecked()
  await userEvent.click(toggle)
  await waitFor(() => expect(toggle).toBeChecked())
  expect(calls).toContainEqual({ channel: 'offline:pin', request: { kind: 'library', ref: 'library', tracks: [{ key: 'a/one.mp3', inLibrary: true }, { key: 'a/two.mp3', inLibrary: true }] } })
  await userEvent.click(toggle)
  await waitFor(() => expect(toggle).not.toBeChecked())
  expect(calls).toContainEqual({ channel: 'offline:unpin', request: { pinId: 'library:library' } })
})
it('keeps the automatic switch off and gives the refusal reason when the pin fails', async () => {
  await show(); refuse = true
  await userEvent.click(screen.getByRole('switch'))
  expect(await screen.findByRole('alert')).toHaveTextContent('Sin espacio')
  expect(screen.getByRole('switch')).not.toBeChecked()
})
it('clears cache through pools and refreshes the value', async () => {
  await show(); await userEvent.click(screen.getByRole('button', { name: 'Borrar caché' }))
  expect(await screen.findByText('0 B de 2 GB')).toBeInTheDocument()
  expect(calls).toContainEqual({ channel: 'offline:pools', request: { action: 'clear-cache' } })
})
it('requires the real confirm, allows cancellation, then removes all downloads', async () => {
  await show()
  await userEvent.click(screen.getByRole('button', { name: 'Eliminar todas las descargas' }))
  let dialog = await screen.findByRole('alertdialog')
  expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus()
  expect(calls.some(call => (call.request as { action?: string })?.action === 'remove-downloads')).toBe(false)
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancelar' }))
  await userEvent.click(screen.getByRole('button', { name: 'Eliminar todas las descargas' }))
  dialog = await screen.findByRole('alertdialog')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Eliminar todas las descargas' }))
  expect(await screen.findByText('0 canciones · 0 B')).toBeInTheDocument()
  expect(calls.filter(call => (call.request as { action?: string })?.action === 'remove-downloads')).toHaveLength(1)
})
it('retries failed collection pins and removes only the failed track from every owning pin', async () => {
  status.tracks = [{ key: 'a/one.mp3', state: 'fallido', pool: 'offline', bytes: 0, error: 'no-space', etag: null, verifiedAt: null, lastPlayedAt: null }]
  pools.pins!.push({ id: 'song:a/one.mp3', kind: 'song', ref: 'a/one.mp3', tracks: ['a/one.mp3'] })
  await show()
  expect(screen.getByText('Sin espacio')).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Eliminar' })).toBeEnabled())
  expect(calls).toContainEqual({ channel: 'offline:pin', request: { kind: 'album', ref: 'a', tracks: [{ key: 'a/one.mp3', inLibrary: true }, { key: 'a/two.mp3', inLibrary: true }] } })
  await userEvent.click(screen.getByRole('button', { name: 'Eliminar' }))
  await waitFor(() => expect(calls).toContainEqual({ channel: 'offline:unpin', request: { pinId: 'song:a/one.mp3' } }))
  expect(calls).toContainEqual({ channel: 'offline:pin', request: { kind: 'album', ref: 'a', tracks: [{ key: 'a/two.mp3', inLibrary: true }] } })
})
