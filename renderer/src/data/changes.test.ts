import { focusManager, QueryClient, QueryObserver } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import cases from '../../../contracts/change-events.json'
import areas from '../../../contracts/change-areas.json'
import type { IpcEventChannel, KrobiBridge, ServerHello } from '../lib/ipc'
import { changeAreas, changeHandler, startChanges } from './changes'
import { watchChanges } from './changeListeners'
import { setStreamState, streamStore } from './streamState'

let client: QueryClient
const stops: (() => void)[] = []
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }
beforeEach(() => {
  focusManager.setFocused(true)
  setStreamState({ state: 'connecting', since: Date.now() })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
})
afterEach(() => { stops.splice(0).forEach(stop => stop()); client.clear(); focusManager.setFocused(undefined); vi.unstubAllGlobals() })
async function mounted(key: readonly unknown[], enabled = true) {
  const read = vi.fn(async () => 'snapshot')
  const observer = new QueryObserver(client, { queryKey: key, queryFn: read, enabled })
  stops.push(observer.subscribe(() => {}))
  await settle()
  return read
}
function handler() { const handler = changeHandler(client); stops.push(handler.dispose); return handler }

describe('area changes', () => {
  it('reads the shared area contract and refetches only mounted enabled library queries', async () => {
    expect(changeAreas).toEqual(areas.areas)
    const albums = await mounted(['library', 'albums', { covers: false }])
    const unrelated = await mounted(['compute', 'summary'])
    const disabled = await mounted(['library', 'disabled'], false)
    await client.fetchQuery({ queryKey: ['library', 'inactive'], queryFn: async () => 'cached' })
    const h = handler()
    h.changed({ area: 'library', rev: 'opaque' }); await settle()
    expect(albums).toHaveBeenCalledTimes(2)
    expect(unrelated).toHaveBeenCalledTimes(1)
    expect(disabled).not.toHaveBeenCalled()
    expect(client.getQueryState(['library', 'inactive'])?.isInvalidated).toBe(false)
    h.changed({ area: 'library', rev: 'opaque' }); await settle()
    expect(albums).toHaveBeenCalledTimes(2)
  })
  it('refreshes source health and tool facts on jobs and config changes', async () => {
    const providers = await mounted(['server', 'providers'])
    const h = handler()
    h.changed({ area: 'jobs', rev: 1 }); await settle()
    expect(providers).toHaveBeenCalledTimes(2)
    h.changed({ area: 'config', rev: 1 }); await settle()
    expect(providers).toHaveBeenCalledTimes(3)
  })
  it('defers hidden changes and refetches once per dirty area on focus', async () => {
    const albums = await mounted(['library', 'albums'])
    const compute = await mounted(['compute', 'summary'])
    const h = handler()
    const read = vi.fn(async () => {})
    stops.push(watchChanges(['library'], read, false))
    focusManager.setFocused(false)
    h.changed({ area: 'library', rev: 1 }); h.changed({ area: 'library', rev: 2 })
    h.changed({ area: 'config', rev: 1 })
    await settle()
    expect(albums).toHaveBeenCalledTimes(1); expect(compute).toHaveBeenCalledTimes(1)
    expect(read).not.toHaveBeenCalled()
    focusManager.setFocused(true); await settle()
    expect(albums).toHaveBeenCalledTimes(2); expect(compute).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenCalledTimes(1)
    focusManager.setFocused(false); focusManager.setFocused(true); await settle()
    expect(albums).toHaveBeenCalledTimes(2); expect(read).toHaveBeenCalledTimes(1)
  })
  it('defers a queued invalidation if focus is lost before cancellation completes', async () => {
    const albums = await mounted(['library', 'albums'])
    const h = handler()
    h.changed({ area: 'library', rev: 1 })
    focusManager.setFocused(false)
    await settle()
    expect(albums).toHaveBeenCalledTimes(1)
    focusManager.setFocused(true); await settle()
    expect(albums).toHaveBeenCalledTimes(2)
  })
  it('maps account areas to personal keys using the contract', async () => {
    const profile = await mounted(['me', 'library'])
    const albums = await mounted(['library', 'albums'])
    const unrelated = await mounted(['compute', 'summary'])
    handler().changed({ area: 'me:account-a', rev: 3 }); await settle()
    expect(profile).toHaveBeenCalledTimes(2); expect(albums).toHaveBeenCalledTimes(2)
    expect(unrelated).toHaveBeenCalledTimes(1)
  })
  it('resyncs all displayed queries on a new boot, then only differing revisions', async () => {
    const albums = await mounted(['library', 'albums'])
    const compute = await mounted(['compute', 'summary'])
    const other = await mounted(['stems', 'song'])
    const h = handler()
    const hello = cases.hello.data as ServerHello
    h.hello(hello); await settle()
    expect(albums).toHaveBeenCalledTimes(2); expect(compute).toHaveBeenCalledTimes(2); expect(other).toHaveBeenCalledTimes(2)
    h.hello(hello); await settle()
    expect(albums).toHaveBeenCalledTimes(2)
    h.hello({ ...hello, revisions: { ...hello.revisions, library: 'different' } }); await settle()
    expect(albums).toHaveBeenCalledTimes(3); expect(compute).toHaveBeenCalledTimes(2)
    focusManager.setFocused(false)
    h.hello({ ...hello, bootId: 'new-boot' }); await settle()
    expect(albums).toHaveBeenCalledTimes(3)
    focusManager.setFocused(true); await settle()
    expect(albums).toHaveBeenCalledTimes(4); expect(compute).toHaveBeenCalledTimes(3)
  })
  it('serializes store reads and preserves a change arriving during a snapshot', async () => {
    let finish!: () => void
    const read = vi.fn().mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve })).mockResolvedValue(undefined)
    stops.push(watchChanges(['jobs'], read))
    const h = handler()
    h.changed({ area: 'jobs', rev: 1 }); h.changed({ area: 'jobs', rev: 2 })
    expect(read).toHaveBeenCalledTimes(1)
    finish(); await settle()
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('subscribes before reading the shell snapshot and exposes stream state', async () => {
    const events = new Map<IpcEventChannel, (payload: never) => void>()
    const read = await mounted(['library', 'albums'])
    const bridge: KrobiBridge = {
      on: ((channel, listener) => { events.set(channel, listener as (payload: never) => void); return () => { events.delete(channel) } }) as KrobiBridge['on'],
      invoke: vi.fn(async () => {
        expect(events.has('server:hello')).toBe(true)
        return { hello: cases.hello.data, stream: { state: 'connected', since: 123 } }
      }) as KrobiBridge['invoke'],
    }
    stops.push(startChanges(client, bridge)); await settle()
    expect(read).toHaveBeenCalledTimes(2)
    expect(streamStore.getSnapshot()).toEqual({ state: 'connected', since: 123 })
    events.get('server:changed')?.({ area: 'library', rev: 'next' } as never); await settle()
    expect(read).toHaveBeenCalledTimes(3)
    const hello = { ...cases.hello.data, revisions: { ...cases.hello.data.revisions, library: 'next' } }
    events.get('server:stream')?.({ state: 'lost', since: 456 } as never)
    events.get('server:stream')?.({ state: 'connected', since: 789 } as never)
    expect(streamStore.getSnapshot()).toEqual({ state: 'connected', since: 789 })
    events.get('server:hello')?.(hello as never); await settle()
    expect(read).toHaveBeenCalledTimes(4)
  })
  it('replaces an initial snapshot already in flight when a change arrives', async () => {
    let finish!: (value: string) => void
    const read = vi.fn().mockImplementationOnce(() => new Promise<string>(resolve => { finish = resolve })).mockResolvedValue('fresh')
    const observer = new QueryObserver(client, { queryKey: ['library', 'albums'], queryFn: read })
    stops.push(observer.subscribe(() => {}))
    handler().changed({ area: 'library', rev: 1 })
    await settle()
    expect(observer.getCurrentResult().data).toBe('fresh')
    finish('old snapshot'); await settle()
    expect(observer.getCurrentResult().data).toBe('fresh')
  })
  it('reads the shell snapshot again if a change arrived during IPC', async () => {
    const events = new Map<IpcEventChannel, (payload: never) => void>()
    let finish!: (value: unknown) => void
    const snapshot = { hello: cases.hello.data, stream: { state: 'connected', since: 123 } }
    const invoke = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValue(snapshot)
    const bridge: KrobiBridge = {
      on: ((channel, listener) => { events.set(channel, listener as (payload: never) => void); return () => { events.delete(channel) } }) as KrobiBridge['on'],
      invoke: invoke as KrobiBridge['invoke'],
    }
    stops.push(startChanges(client, bridge))
    events.get('server:changed')?.({ area: 'library', rev: 'newer' } as never)
    finish(snapshot); await settle()
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('uses direct EventSource in browser development and closes on disposal', async () => {
    const sources: FakeSource[] = []
    class FakeSource {
      events = new Map<string, (event: { data: string }) => void>()
      close = vi.fn()
      onerror: (() => void) | undefined
      constructor(public url: string) { sources.push(this) }
      addEventListener(name: string, listener: (event: { data: string }) => void) { this.events.set(name, listener) }
    }
    vi.stubGlobal('EventSource', FakeSource)
    const read = await mounted(['library'])
    const stop = startChanges(client, null)
    expect(sources[0].url).toContain('/api/events')
    sources[0].events.get('hello')?.({ data: JSON.stringify(cases.hello.data) }); await settle()
    expect(read).toHaveBeenCalledTimes(2)
    sources[0].onerror?.()
    expect(streamStore.getSnapshot().state).toBe('lost')
    const loss = streamStore.getSnapshot()
    await settle()
    sources[0].onerror?.()
    expect(streamStore.getSnapshot()).toBe(loss)
    sources[0].events.get('hello')?.({ data: JSON.stringify(cases.hello.data) }); await settle()
    expect(streamStore.getSnapshot().state).toBe('connected')
    expect(read).toHaveBeenCalledTimes(3)
    stop(); expect(sources[0].close).toHaveBeenCalledTimes(1)
  })
})
