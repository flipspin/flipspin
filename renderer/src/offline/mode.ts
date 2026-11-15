import { useSyncExternalStore } from 'react'
import { bridge, hasBridge } from '../bridge'
import type { KrobiBridge } from '../lib/ipc'

let forced = false
let link: KrobiBridge | undefined
let stop: (() => void) | undefined
const listeners = new Set<() => void>()
const publish = (value: boolean) => { if (forced === value) return; forced = value; for (const notify of listeners) notify() }
function ensure() {
  const current = hasBridge() ? bridge() : undefined
  if (current === link) return
  stop?.(); link = current; forced = false
  if (!current) return
  const refresh = () => { void current.invoke('offline:mode', {}).then(value => {
    if (link === current && value) publish(value.forced)
  }).catch(() => {}) }
  stop = current.on('offline:changed', refresh)
  refresh()
}
export function getForcedOffline() { ensure(); return forced }
export function subscribeMode(notify: () => void) { ensure(); listeners.add(notify); return () => { listeners.delete(notify) } }
export function useForcedOffline() { return useSyncExternalStore(subscribeMode, getForcedOffline) }
export async function setForcedOffline(value: boolean) {
  const result = await bridge().invoke('offline:mode', { forced: value })
  publish(result.forced)
}
