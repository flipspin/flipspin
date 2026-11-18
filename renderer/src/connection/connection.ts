/** The shell is the only reachability judge. Browser development stays online. */
import { getForcedOffline, subscribeMode } from '../offline/mode'
import { useSyncExternalStore } from 'react'
import { onlineManager } from '@tanstack/react-query'
import { bridge, hasBridge } from '../bridge'
import type { KrobiBridge, ServerConnection, ServerStatus } from '../lib/ipc'

type Snapshot =
  | { kind: 'loading' }
  | { kind: 'ready'; value: ServerStatus | null }
  | { kind: 'no-bridge' }

const connecting: ServerConnection = { state: 'connecting', since: 0, attempt: 0, lastError: null, checks: [] }
const browserConnection: ServerConnection = { ...connecting, state: 'connected' }
const listeners = new Set<() => void>()
let snapshot: Snapshot = { kind: 'no-bridge' }
let link: KrobiBridge | null | undefined
let stop = () => {}
let revision = 0

let syncRevision = 0
let wasConnected = false
function publish(next: Snapshot) {
  snapshot = next
  const connected = !getForcedOffline() && next.kind === 'ready' && next.value?.connection.state === 'connected'
  const reconnected = connected && !wasConnected
  wasConnected = connected
  // Only a real transition touches onlineManager. The shell republishes its
  // status every few seconds; dropping offline on each one and coming back
  // after a sync read as a reconnect and reloaded the library twice per event.
  if (next.kind === 'no-bridge') onlineManager.setOnline(true)
  else if (!connected) { syncRevision++; onlineManager.setOnline(false) }
  // Reconnect order is durable intents → snapshots → network queries/streams.
  const version = reconnected ? ++syncRevision : syncRevision
  if (reconnected && link) {
    onlineManager.setOnline(false)
    // Online either way: a failed sync (one stale snapshot answering 404)
    // is not evidence that the nest is unreachable, and staying offline left
    // every page that reads the nest on "Loading…" forever.
    const online = () => { if (syncRevision === version) onlineManager.setOnline(true) }
    void link.invoke('offline:sync', undefined).then(online, online)
  }
  for (const listener of listeners) listener()
}

function ensureStarted() {
  const current = hasBridge() ? bridge() : null
  if (current === link) return
  stop()
  link = current
  // navigator.onLine is not evidence about this nest (including a local nest).
  onlineManager.setEventListener(() => () => {})
  if (!current) {
    publish({ kind: 'no-bridge' })
    stop = () => {}
    return
  }
  publish({ kind: 'loading' })
  const modeStop = subscribeMode(() => publish(snapshot))
  const synced = current.on('offline:synced', () => { if (!getForcedOffline() && snapshot.kind === 'ready' && snapshot.value?.connection.state === 'connected') onlineManager.setOnline(true); window.dispatchEvent(new CustomEvent('library-changed', { detail: { source: 'sincronización' } })); window.dispatchEvent(new CustomEvent('playlists-changed')) })
  const unsubscribe = current.on('server:status-changed', value => {
    revision++
    publish({ kind: 'ready', value })
  })
  const refresh = () => {
    if (!document.hidden) void refreshConnection()
  }
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refresh)
  stop = () => {
    revision++
    unsubscribe()
    modeStop()
    synced()
    window.removeEventListener('focus', refresh)
    document.removeEventListener('visibilitychange', refresh)
  }
  void refreshConnection()
}

/** A late read must never replace a newer pushed status. */
export async function refreshConnection() {
  ensureStarted()
  const current = link
  const readRevision = ++revision
  if (!current) return
  try {
    const value = await current.invoke('server:get-status', undefined)
    if (current === link && readRevision === revision) publish({ kind: 'ready', value })
  } catch {
    // An IPC failure is not evidence of an unreachable nest. Keep waiting for
    // the shell's next event or focus read, without inventing a network state.
  }
}

export const connectionStore = {
  getSnapshot(): Snapshot {
    ensureStarted()
    return snapshot
  },
  subscribe(listener: () => void) {
    ensureStarted()
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) {
        stop()
        link = undefined
      }
    }
  },
}

export function useConnectionStatus(): Snapshot {
  return useSyncExternalStore(connectionStore.subscribe, connectionStore.getSnapshot)
}

export function useConnection(): ServerConnection {
  const status = useConnectionStatus()
  if (status.kind === 'no-bridge') return browserConnection
  return status.kind === 'ready' ? status.value?.connection ?? connecting : connecting
}
