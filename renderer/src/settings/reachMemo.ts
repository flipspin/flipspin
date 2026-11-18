/**
 * The last "Check" verdict of "Remote access", kept for this run of the
 * app so "Overview" can say whether the outside addresses were checked and how
 * it went. Not persisted: a verdict is only as good as the network it was
 * taken on.
 */
import { useSyncExternalStore } from 'react'

import type { Reach } from '../remote/useNestAddresses'

let last: Reach | null = null
let lastKey: string | undefined
const listeners = new Set<() => void>()

export function rememberReach(reach: Reach, key?: string): void {
  lastKey = key
  last = reach
  listeners.forEach((listener) => listener())
}

export function forgetReachForTest(): void {
  last = null
}

export function useLastReach(key?: string): Reach | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => key === lastKey ? last : null,
    () => key === lastKey ? last : null,
  )
}
