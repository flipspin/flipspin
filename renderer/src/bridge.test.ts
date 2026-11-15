import { afterEach, expect, it } from 'vitest'
import { bridge, setFakeBridgeForTest } from './bridge'
import type { IpcInvokeContract, KrobiBridge } from './lib/ipc'

let restore: (() => void) | undefined
afterEach(() => restore?.())

it('carries offline calls and invalidation through the typed bridge seam', async () => {
  const calls: { channel: string; request: unknown }[] = []
  const listeners = new Set<() => void>()
  const status: IpcInvokeContract['offline:status']['response'] = {
    pins: 1, files: 1, bytes: 5,
    tracks: [{ key: 'A/one.mp3', pool: 'offline', state: 'descargado', bytes: 5, etag: '"v1"', verifiedAt: 1, lastPlayedAt: null, error: null }],
  }
  const pools: IpcInvokeContract['offline:pools']['response'] = {
    offline: { bytes: 5, files: 1, location: '/app/offline' },
    cache: { bytes: 0, files: 0, location: '/caches/media' }, cacheBudget: 52428800,
  }
  const fake: KrobiBridge = {
    invoke: (async (channel: string, request: unknown) => {
      calls.push({ channel, request })
      switch (channel) {
        case 'offline:status': return status
        case 'offline:pools': return pools
        case 'offline:pin':
          for (const listener of listeners) listener()
          return { ok: true, pinId: 'song:A/one.mp3' }
        case 'offline:unpin': return { ok: true }
        default: throw new Error(`unexpected channel ${channel}`)
      }
    }) as KrobiBridge['invoke'],
    on: ((channel: string, listener: (payload: null) => void) => {
      if (channel !== 'offline:changed') throw new Error(`unexpected event ${channel}`)
      const notify = () => listener(null)
      listeners.add(notify)
      return () => { listeners.delete(notify) }
    }) as KrobiBridge['on'],
  }
  restore = setFakeBridgeForTest(fake)
  let changes = 0
  const unsubscribe = bridge().on('offline:changed', () => { changes += 1 })
  const pin = { kind: 'song', ref: 'A/one.mp3', tracks: [{ key: 'A/one.mp3', inLibrary: true }] } as const
  expect(await bridge().invoke('offline:pin', { ...pin, tracks: [...pin.tracks] })).toEqual({ ok: true, pinId: 'song:A/one.mp3' })
  expect(await bridge().invoke('offline:status', { keys: ['A/one.mp3'] })).toEqual(status)
  expect(await bridge().invoke('offline:pools', { action: 'get' })).toEqual(pools)
  expect(await bridge().invoke('offline:pools', { action: 'clear-cache' })).toEqual(pools)
  expect(await bridge().invoke('offline:pools', { action: 'remove-downloads' })).toEqual(pools)
  expect(await bridge().invoke('offline:unpin', { pinId: 'song:A/one.mp3' })).toEqual({ ok: true })
  expect(changes).toBe(1)
  unsubscribe()
  expect(listeners.size).toBe(0)
  expect(calls.map(c => c.channel)).toEqual(['offline:pin', 'offline:status', 'offline:pools', 'offline:pools', 'offline:pools', 'offline:unpin'])
})
