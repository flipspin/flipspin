/** Reconcile durable pins without restarting work on reachability notifications. */
import { bridge } from '../bridge'
import { connectionStore } from '../connection/connection'
import { isOfflineNow } from './policy'

const COOLDOWN = 10 * 60 * 1000
const BACKOFF = [15000, 60000, 300000]
type Cache = (key: string, signal: AbortSignal) => Promise<void>
type Eligible = (keys: string[], signal: AbortSignal) => Promise<string[]>
let owner: { stop: () => void; done: Promise<void> } | undefined

/** Replace the local owner; Web Locks also serialize the two desktop windows.
 * Retain ownership until aborted transports settle, including on replacement. */
export function watchOfflineLyrics(cache: Cache, eligible?: Eligible) {
  const previous = owner
  previous?.stop()
  const controller = new AbortController()
  let stopped!: () => void
  const stopping = new Promise<void>(resolve => { stopped = resolve })
  let stopWatcher: (() => Promise<void>) | undefined
  let draining: Promise<void> | undefined
  const stop = () => {
    controller.abort()
    draining ??= stopWatcher?.()
    stopped()
  }
  const start = async () => {
    if (controller.signal.aborted) return
    stopWatcher = startWatcher(cache, eligible)
    await stopping
    draining ??= stopWatcher()
    await draining
  }
  const done = (previous?.done ?? Promise.resolve()).then(async () => {
    if (controller.signal.aborted) return
    if (navigator.locks) {
      await navigator.locks.request('krobi-offline-lyrics', { signal: controller.signal }, start).catch(error => {
        if (!controller.signal.aborted) throw error
      })
    } else await start()
  })
  owner = { stop, done }
  return stop
}

function startWatcher(cache: Cache, eligible?: Eligible) {
  const native = bridge()
  let stopped = false
  let running: Promise<void> | undefined
  let dirty = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller = new AbortController()
  let pending = new Set<string>()
  const completed = new Set<string>()
  let finishedAt: number | undefined
  let failures = 0
  let retryAt = 0
  const connected = () => {
    const status = connectionStore.getSnapshot()
    return !stopped && !isOfflineNow() && status.kind === 'ready' && status.value?.connection.state === 'connected'
  }
  const schedule = (delay = 100) => {
    if (!connected() || running) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      running = run().finally(() => {
        running = undefined
        if (connected() && (dirty || pending.size)) schedule()
      })
    }, Math.max(delay, retryAt - Date.now()))
  }
  async function run() {
    if (!connected()) return
    const signal = controller.signal
    const active = () => connected() && !signal.aborted
    let failed = false
    try {
      if (dirty) {
        dirty = false
        const pools = await native.invoke('offline:pools', { action: 'get' })
        const keys = [...new Set(pools.pins?.flatMap(pin => pin.tracks) ?? [])]
        const candidates = eligible ? await eligible(keys, signal) : keys
        if (!active()) { dirty = true; return }
        pending = new Set(candidates.filter(key => !completed.has(key)))
      }
      await Promise.all(Array.from({ length: Math.min(3, pending.size) }, async () => {
        while (active() && !failed && pending.size) {
          const key = pending.values().next().value!
          pending.delete(key)
          try {
            await cache(key, signal)
            if (active()) completed.add(key)
            else pending.add(key)
          } catch {
            pending.add(key)
            if (!signal.aborted) failed = true
          }
        }
      }))
    } catch {
      dirty = true
      if (!signal.aborted) failed = true
    } finally {
      if (failed) {
        retryAt = Date.now() + BACKOFF[Math.min(failures++, BACKOFF.length - 1)]
      } else if (active() && !pending.size) {
        failures = 0; retryAt = 0; finishedAt = Date.now()
      }
    }
  }
  const changed = native.on('offline:changed', change => { if (change && !change.pins) return; dirty = true; schedule() })
  let wasConnected = connected()
  const connection = connectionStore.subscribe(() => {
    const online = connected()
    if (!online) {
      controller.abort(); clearTimeout(timer)
    } else if (!wasConnected) {
      controller = new AbortController()
      if (finishedAt !== undefined && Date.now() - finishedAt >= COOLDOWN) {
        completed.clear(); dirty = true
      }
      if (dirty || pending.size) schedule()
    }
    wasConnected = online
  })
  schedule()
  return async () => {
    stopped = true; controller.abort(); clearTimeout(timer)
    changed(); connection()
    await running
  }
}
