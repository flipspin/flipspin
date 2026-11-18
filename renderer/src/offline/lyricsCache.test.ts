import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { watchOfflineLyrics } from './lyricsCache'

const fake = vi.hoisted(() => ({
  state: 'connected',
  listeners: new Set<() => void>(),
  changed: new Set<() => void>(),
  pools: vi.fn(),
}))
vi.mock('../bridge', () => ({ bridge: () => ({
  invoke: fake.pools,
  on: (_: string, fn: () => void) => { fake.changed.add(fn); return () => fake.changed.delete(fn) },
}) }))
vi.mock('../connection/connection', () => ({ connectionStore: {
  getSnapshot: () => ({ kind: 'ready', value: { connection: { state: fake.state } } }),
  subscribe: (fn: () => void) => { fake.listeners.add(fn); return () => fake.listeners.delete(fn) },
} }))
vi.mock('./policy', () => ({ isOfflineNow: () => false }))
let stop: (() => void) | undefined
const keys = Array.from({ length: 1800 }, (_, i) => `Album/${i}.mp3`)
function connection(state: string) { fake.state = state; fake.listeners.forEach(fn => fn()) }
beforeEach(() => {
  vi.useFakeTimers()
  fake.state = 'connected'; fake.pools.mockResolvedValue({ pins: [{ tracks: keys }] })
})
afterEach(async () => {
  stop?.(); await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers(); fake.pools.mockClear()
})

it('keeps 1800 hanging transports at three, even through timeouts and reconnects', async () => {
  let active = 0; let peak = 0
  const cache = vi.fn((_: string, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
    peak = Math.max(peak, ++active)
    const abort = () => finish(signal.reason)
    const timeout = setTimeout(() => finish(new Error('timeout')), 15000)
    function finish(error: unknown) {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      active--; reject(error)
    }
    signal.addEventListener('abort', abort, { once: true })
  }))
  stop = watchOfflineLyrics(cache)
  await vi.advanceTimersByTimeAsync(101)
  expect(active).toBe(3)
  await vi.advanceTimersByTimeAsync(16 * 60 * 1000)
  expect(peak).toBe(3)
  expect(cache.mock.calls.length).toBeLessThan(30)
  connection('connecting'); connection('connected')
  await vi.advanceTimersByTimeAsync(100)
  expect(peak).toBe(3)
})

it('waits for aborted transports to settle before a replacement starts', async () => {
  const releases: (() => void)[] = []
  const cache = vi.fn(() => new Promise<void>(resolve => releases.push(resolve)))
  stop = watchOfflineLyrics(cache)
  await vi.advanceTimersByTimeAsync(101)
  expect(cache).toHaveBeenCalledTimes(3)
  stop = watchOfflineLyrics(cache)
  await vi.advanceTimersByTimeAsync(1000)
  expect(cache).toHaveBeenCalledTimes(3)
  releases.splice(0).forEach(resolve => resolve())
  await vi.advanceTimersByTimeAsync(101)
  expect(cache).toHaveBeenCalledTimes(6)
  stop(); releases.splice(0).forEach(resolve => resolve())
})

it('resumes interrupted keys without restarting a pass on reconnect or status updates', async () => {
  const done: (() => void)[] = []
  const cache = vi.fn((_: string, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    done.push(resolve)
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  stop = watchOfflineLyrics(cache)
  await vi.advanceTimersByTimeAsync(101)
  done.shift()!(); await vi.advanceTimersByTimeAsync(0)
  expect(cache).toHaveBeenCalledTimes(4)
  connection('connected'); connection('connected')
  await vi.advanceTimersByTimeAsync(1000)
  expect(fake.pools).toHaveBeenCalledTimes(1)
  connection('connecting'); connection('connected')
  await vi.advanceTimersByTimeAsync(101)
  expect(fake.pools).toHaveBeenCalledTimes(1)
  expect(cache.mock.calls.filter(([key]) => key === keys[0])).toHaveLength(1)
})

it('only runs while connected and leaves a completed pass alone for ten minutes', async () => {
  fake.state = 'connecting'
  const cache = vi.fn().mockResolvedValue(undefined)
  stop = watchOfflineLyrics(cache)
  await vi.advanceTimersByTimeAsync(1000)
  expect(fake.pools).not.toHaveBeenCalled()
  connection('connected'); await vi.advanceTimersByTimeAsync(101)
  expect(cache).toHaveBeenCalledTimes(1800)
  connection('connecting'); connection('connected')
  await vi.advanceTimersByTimeAsync(9 * 60 * 1000)
  expect(fake.pools).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(60 * 1000)
  connection('connecting'); connection('connected'); await vi.advanceTimersByTimeAsync(101)
  expect(fake.pools).toHaveBeenCalledTimes(2)
})

it('stops after a failed batch and backs off 15 seconds, one minute, then five minutes', async () => {
  const cache = vi.fn().mockRejectedValue(new Error('nest unavailable'))
  stop = watchOfflineLyrics(cache)
  await vi.advanceTimersByTimeAsync(101)
  expect(cache).toHaveBeenCalledTimes(3)
  for (const [delay, calls] of [[15000, 6], [60000, 9], [300000, 12]]) {
    connection('connecting'); connection('connected')
    fake.changed.forEach(fn => fn())
    await vi.advanceTimersByTimeAsync(delay - 2)
    expect(cache).toHaveBeenCalledTimes(calls - 3)
    await vi.advanceTimersByTimeAsync(2)
    expect(cache).toHaveBeenCalledTimes(calls)
  }
})

it('only passes eligible songs to workers', async () => {
  const cache = vi.fn().mockResolvedValue(undefined)
  stop = watchOfflineLyrics(cache, async () => [keys[1], keys[8]])
  await vi.advanceTimersByTimeAsync(101)
  expect(cache.mock.calls.map(([key]: [string]) => key)).toEqual([keys[1], keys[8]])
})

it('allows only one window to own the watcher through a shared Web Lock', async () => {
  const prior = Object.getOwnPropertyDescriptor(navigator, 'locks')
  let tail = Promise.resolve()
  const request = vi.fn((_name: string, options: { signal: AbortSignal }, callback: () => Promise<void>) => {
    const next = tail.then(() => { if (!options.signal.aborted) return callback() })
    tail = next
    return next
  })
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
  const first = vi.fn().mockResolvedValue(undefined)
  const second = vi.fn().mockResolvedValue(undefined)
  const stopFirst = watchOfflineLyrics(first)
  vi.resetModules()
  const otherWindow = await import('./lyricsCache')
  stop = otherWindow.watchOfflineLyrics(second)
  try {
    await vi.advanceTimersByTimeAsync(101)
    expect(first).toHaveBeenCalledTimes(1800)
    expect(second).not.toHaveBeenCalled()
    expect(request.mock.calls.map(([name]) => name)).toEqual(['krobi-offline-lyrics', 'krobi-offline-lyrics'])
    stopFirst()
    await vi.advanceTimersByTimeAsync(101)
    expect(second).toHaveBeenCalledTimes(1800)
  } finally {
    stopFirst(); stop()
    await vi.advanceTimersByTimeAsync(0)
    if (prior) Object.defineProperty(navigator, 'locks', prior)
    else Reflect.deleteProperty(navigator, 'locks')
  }
})
