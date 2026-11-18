import { useSyncExternalStore } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import type { ApiData } from '../data'

export type Split = ApiData<'/api/stems', 'get'>['splits'][number]
export const splitKey = (split: Pick<Split, 'album' | 'file'>) => JSON.stringify([split.album, split.file])

/** Pending rows stay hidden across section navigation and list refetches.
 * The toast owns cancellation/expiry; no timer here can outlive its undo UI.
 */
function createPending() {
  const operations = new Map<symbol, string[]>()
  const listeners = new Set<() => void>()
  let snapshot = new Set<string>()
  function publish() {
    snapshot = new Set([...operations.values()].flat())
    listeners.forEach(fn => fn())
  }
  return {
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    getSnapshot: () => snapshot,
    hide: (splits: Split[]) => {
      const token = Symbol()
      operations.set(token, splits.map(splitKey))
      publish()
      return () => { operations.delete(token); publish() }
    },
  }
}
const pendingByClient = new WeakMap<QueryClient, ReturnType<typeof createPending>>()

export function useSplitDeletes() {
  const client = useQueryClient()
  let pending = pendingByClient.get(client)
  if (!pending) { pending = createPending(); pendingByClient.set(client, pending) }
  const hidden = useSyncExternalStore(pending.subscribe, pending.getSnapshot)
  return { hidden, hide: pending.hide }
}
