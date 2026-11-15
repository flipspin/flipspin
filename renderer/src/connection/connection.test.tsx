import { act, renderHook, waitFor } from '@testing-library/react'
import { onlineManager } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataProvider, createQueryClient, useLibraryAlbums, useServerHandshake } from '../data'
import { useConnection, useConnectionStatus } from './connection'
import { installFakeSettings, serverStatus, type FakeSettings } from '../settings/test-support'
import type { ServerConnection } from '../lib/ipc'

const status = (state: ServerConnection['state']) => serverStatus({ connection: { state, since: 0, attempt: 1, lastError: null, checks: [] } })
let fake: FakeSettings | undefined
afterEach(() => { fake?.restore(); fake = undefined; vi.restoreAllMocks() })

describe('shell connection adapter', () => {
  it('pauses queries while connecting and resumes the albums request exactly once', async () => {
    fake = installFakeSettings({ status: status('connecting'), respond: () => ({ status: 200, json: [] }) })
    const client = createQueryClient()
    const { result } = renderHook(() => useLibraryAlbums(), { wrapper: ({ children }) => <DataProvider queryClient={client}>{children}</DataProvider> })
    await waitFor(() => expect(result.current.fetchStatus).toBe('paused'))
    expect(result.current.status).toBe('pending')
    expect(result.current.isError).toBe(false)
    expect(fake.requests).toHaveLength(0)
    // Browser network events cannot override the shell's answer.
    act(() => window.dispatchEvent(new Event('online')))
    expect(onlineManager.isOnline()).toBe(false)
    act(() => fake!.emitServerStatus(status('connected')))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    act(() => fake!.emitServerStatus(status('connected')))
    expect(fake.requests.filter(r => r.pathname === '/api/listar-albums-con-metadata')).toHaveLength(1)
    act(() => fake!.emitServerStatus(status('unreachable')))
    expect(onlineManager.isOnline()).toBe(false)
    expect(result.current.data).toEqual([])
  })

  it('a repeated connected status is not a reconnect: no offline flip, no second sync', async () => {
    fake = installFakeSettings({ status: status('connecting'), respond: () => ({ status: 200, json: [] }) })
    renderHook(() => useConnection(), { wrapper: ({ children }) => <DataProvider queryClient={createQueryClient()}>{children}</DataProvider> })
    act(() => fake!.emitServerStatus(status('connected')))
    await waitFor(() => expect(onlineManager.isOnline()).toBe(true))
    const syncs = fake.invokedWith('offline:sync').length
    const flips: boolean[] = []
    const off = onlineManager.subscribe(online => flips.push(online))
    act(() => { fake!.emitServerStatus(status('connected')); fake!.emitServerStatus(status('connected')) })
    await act(async () => {})
    off()
    expect(flips).toEqual([])
    expect(fake.invokedWith('offline:sync')).toHaveLength(syncs)
  })

  it('a failed sync still lets the app come online: it is not evidence the nest is unreachable', async () => {
    fake = installFakeSettings({ status: status('connecting'), respond: () => ({ status: 200, json: [] }), syncFails: 'snapshot: 404 Not Found' })
    renderHook(() => useConnection(), { wrapper: ({ children }) => <DataProvider queryClient={createQueryClient()}>{children}</DataProvider> })
    expect(onlineManager.isOnline()).toBe(false)
    act(() => fake!.emitServerStatus(status('connected')))
    await waitFor(() => expect(onlineManager.isOnline()).toBe(true))
    expect(fake.invokedWith('offline:sync').length).toBeGreaterThan(0)
  })

  it('does not probe or retry authentication, or retry a failed handshake', async () => {
    fake = installFakeSettings({ status: status('needs-auth') })
    const { result } = renderHook(() => useServerHandshake(), { wrapper: ({ children }) => <DataProvider>{children}</DataProvider> })
    await act(async () => {})
    expect(fake.invokedWith('server:probe')).toHaveLength(0)
    expect(fake.invokedWith('server:retry-now')).toHaveLength(0)
    act(() => fake!.emitServerStatus(status('connected')))
    await waitFor(() => expect(result.current.isError).toBe(true))
    await act(() => new Promise(resolve => setTimeout(resolve, 500)))
    expect(fake.invokedWith('server:probe')).toHaveLength(1)
    expect(fake.invokedWith('server:retry-now')).toHaveLength(0)
  })

  it('uses one subscription and re-reads status on focus', async () => {
    fake = installFakeSettings({ status: status('connecting') })
    const { result, unmount } = renderHook(() => [useConnection(), useConnectionStatus()] as const)
    await waitFor(() => expect(result.current[1].kind).toBe('ready'))
    expect(fake.invokedWith('server:get-status')).toHaveLength(1)
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(fake!.invokedWith('server:get-status')).toHaveLength(2))
    unmount()
    act(() => window.dispatchEvent(new Event('focus')))
    expect(fake.invokedWith('server:get-status')).toHaveLength(2)
  })

  it('keeps browser development online without a bridge', () => {
    const { result } = renderHook(() => useConnection())
    expect(result.current.state).toBe('connected')
    expect(onlineManager.isOnline()).toBe(true)
  })
})
