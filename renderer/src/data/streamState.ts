import { useSyncExternalStore } from 'react'
import type { ServerStream } from '../lib/ipc'

let snapshot: ServerStream = { state: 'connecting', since: Date.now() }
let loss: Pick<ServerStream, 'since'> | null = null
const listeners = new Set<() => void>()
export const streamStore = {
  getSnapshot: () => snapshot,
  getLoss: () => loss,
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
}
export function setStreamState(value: ServerStream) {
  if (snapshot.state === value.state && snapshot.since === value.since) return
  // Native retries pass through connecting. Only recovery or sign-out ends
  // the outage; attempts must not hide the warning or restart its delay.
  if (value.state === 'lost' && !loss) loss = { since: value.since }
  if (value.state === 'connected' || value.state === 'auth') loss = null
  snapshot = value
  listeners.forEach(listener => listener())
}
export function useStreamState() { return useSyncExternalStore(streamStore.subscribe, streamStore.getSnapshot, streamStore.getSnapshot) }
export function useStreamLoss() { return useSyncExternalStore(streamStore.subscribe, streamStore.getLoss, streamStore.getLoss) }
