import { act, cleanup, renderHook } from '@testing-library/react'
import { focusManager, onlineManager, QueryClient, useQuery } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { setFakeBridgeForTest } from '../bridge'
import type { IpcEventChannel, KrobiBridge } from '../lib/ipc'
import { DataProvider } from './provider'
import { createApiClient } from '../api/client'
import { poll, startPoll } from './poll'

vi.mock('../connection/connection', () => ({ useConnection: () => ({ state: 'connected' }), connectionStore: { getSnapshot: () => ({ kind: 'ready', value: { connection: { state: 'connected' }, reachable: true } }) } }))
vi.mock('./library-missing-context', () => ({ LibraryMissingProvider: ({ children }: { children: ReactNode }) => children }))
const reload = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@state/userLibraryStore', () => ({
  getState: () => ({ byRelPath: {} }), subscribe: () => () => {}, load: reload, resetLibrary: () => {},
}))

let restore: (() => void) | undefined
let client: QueryClient
const listeners = new Map<IpcEventChannel, (payload: never) => void>()
function nativeFocus(focused: boolean) { listeners.get('window:focus')?.(focused as never) }
async function flush() { await act(async () => { await vi.advanceTimersByTimeAsync(0) }) }

beforeEach(() => {
  vi.useFakeTimers()
  focusManager.setFocused(true)
  onlineManager.setOnline(true)
  reload.mockClear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
})
afterEach(() => {
  cleanup(); client.clear(); restore?.(); restore = undefined; listeners.clear()
  focusManager.setFocused(undefined); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
function native() {
  restore = setFakeBridgeForTest({
    invoke: vi.fn(async () => ({ tracks: [] })) as KrobiBridge['invoke'],
    on: ((channel, listener) => {
      listeners.set(channel, listener as (payload: never) => void)
      return () => { listeners.delete(channel) }
    }) as KrobiBridge['on'],
  })
}
function Wrapper({ children }: { children: ReactNode }) { return <DataProvider queryClient={client}>{children}</DataProvider> }

describe('poll policies', () => {
  it.each([
    ['idle', false, 60_000], ['active', false, 60_000], ['active', true, 2_000],
    ['restarting', false, 60_000], ['restarting', true, 2_000],
    ['waiting', false, 60_000], ['waiting', true, 2_000],
  ] as const)('%s running=%s returns %s and is off without focus', (policy, running, ms) => {
    expect(poll(policy, running)).toBe(ms)
    focusManager.setFocused(false)
    expect(poll(policy, running)).toBe(false)
  })
  it('supports operation-specific cadences and stopping idle work', () => {
    expect(poll('active', true, 1500, false)).toBe(1500)
    expect(poll('active', false, 1500, false)).toBe(false)
  })
  it('does not treat native focus initialization as returning from a quiet period', async () => {
    focusManager.setFocused(undefined)
    const check = vi.fn()
    const stop = startPoll(() => poll('idle'), check, false)
    focusManager.setFocused(true)
    await flush()
    expect(check).not.toHaveBeenCalled()
    focusManager.setFocused(false); focusManager.setFocused(true)
    await flush()
    expect(check).toHaveBeenCalledTimes(1)
    stop()
  })
  it('removes store timers while quiet and catches up once, including cleanup', async () => {
    const check = vi.fn(async () => {})
    const stop = startPoll(() => poll('active', true), check)
    await flush(); expect(check).toHaveBeenCalledTimes(1)
    focusManager.setFocused(false)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(check).toHaveBeenCalledTimes(1)
    focusManager.setFocused(true); await flush()
    focusManager.setFocused(true); await flush()
    expect(check).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(check).toHaveBeenCalledTimes(3)
    stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(check).toHaveBeenCalledTimes(3)
  })
})

describe('read transport during quiet periods', () => {
  it('never parks a request-driven GET while unfocused', async () => {
    const fetch = vi.fn(async () => Response.json({ state: 'ready' }))
    vi.stubGlobal('fetch', fetch)
    focusManager.setFocused(false)
    await createApiClient(window.location.origin).GET('/api/status')
    expect(fetch).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
  it('queues one catch-up when focus returns during an unfinished store check', async () => {
    let finish!: () => void
    const check = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve })).mockResolvedValue(undefined)
    const stop = startPoll(() => poll('active', true), check)
    focusManager.setFocused(false); focusManager.setFocused(true)
    expect(check).toHaveBeenCalledTimes(1)
    finish(); await flush()
    expect(check).toHaveBeenCalledTimes(2)
    stop()
  })
})

describe('main-window focus', () => {
  it('quiets progress queries and catches up only stream-dirtied areas once', async () => {
    native()
    const query = vi.fn(async () => 'current')
    const inactive = vi.fn(async () => 'unused')
    await client.fetchQuery({ queryKey: ['inactive'], queryFn: inactive })
    renderHook(() => useQuery({ queryKey: ['library', 'mounted'], queryFn: query, refetchInterval: () => poll('active', true) }), { wrapper: Wrapper })
    await flush(); expect(query).toHaveBeenCalledTimes(1)
    act(() => nativeFocus(false)); expect(focusManager.isFocused()).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(360_000) })
    expect(query).toHaveBeenCalledTimes(1); expect(reload).not.toHaveBeenCalled()
    act(() => listeners.get('server:changed')?.({ area: 'library', rev: 1 } as never))
    act(() => nativeFocus(true)); await flush()
    expect(focusManager.isFocused()).toBe(true)
    expect(query).toHaveBeenCalledTimes(2); expect(inactive).toHaveBeenCalledTimes(1); expect(reload).toHaveBeenCalledTimes(1)
    act(() => nativeFocus(true)); await flush()
    expect(query).toHaveBeenCalledTimes(2); expect(reload).toHaveBeenCalledTimes(1)
    act(() => nativeFocus(false)); act(() => nativeFocus(true)); await flush()
    expect(query).toHaveBeenCalledTimes(2); expect(reload).toHaveBeenCalledTimes(1)
  })
  it('keeps main data quiet on player/DOM focus and while minimized', async () => {
    native()
    renderHook(() => null, { wrapper: Wrapper })
    act(() => nativeFocus(false))
    act(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')) })
    expect(focusManager.isFocused()).toBe(false)
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    act(() => nativeFocus(true))
    expect(focusManager.isFocused()).toBe(false)
    expect(reload).not.toHaveBeenCalled()
  })
  it('uses visibility changes in browser development', async () => {
    renderHook(() => null, { wrapper: Wrapper })
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    act(() => document.dispatchEvent(new Event('visibilitychange')))
    expect(focusManager.isFocused()).toBe(false)
    hidden.mockReturnValue(false)
    act(() => document.dispatchEvent(new Event('visibilitychange'))); await flush()
    expect(focusManager.isFocused()).toBe(true); expect(reload).not.toHaveBeenCalled()
  })
})
