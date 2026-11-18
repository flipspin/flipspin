/**
 * Open an Settings section *at* something inside it; a fold, a dialog; from
 * elsewhere. The opener sets a landing and calls `openSettings(section)`; the
 * destination reads it once when it mounts. Plain module state: there is one
 * Settings and one landing at a time.
 */
export type Landing = 'spotify-keys' | 'spotify-export'

let pending: Landing | null = null

export function requestLanding(landing: Landing): void {
  pending = landing
}

/** True when `landing` is pending; leaves it pending (a parent reads first). */
export function peekLanding(landing: Landing): boolean {
  return pending === landing
}

/** True once when `landing` is pending, then clears it. */
export function takeLanding(landing: Landing): boolean {
  if (pending !== landing) return false
  pending = null
  return true
}
