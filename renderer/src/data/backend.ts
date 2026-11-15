/** Resolve credentials at request time because signing in can change them in either window.
 * The transport sends JSON through the Rust proxy and handles browser fallbacks. */

import type { KrobiBridge } from '../lib/ipc'

import { createApiClient, type ApiClient } from '../api/client'
// The one accessor for the preload bridge, and this layer uses it rather than
// reading `globalThis` again. A second reader is a second thing to keep in step
// with the contract and a second seam a test can fake, which is how two parts of
// one app end up disagreeing about whether main is reachable.
import { bridge, hasBridge } from '../bridge'
import { ApiError } from './errors'

/** Convert a missing bridge into ApiError so the retry policy recognizes an unavailable native transport. */
export function optionalBridge(): KrobiBridge | undefined {
  return hasBridge() ? bridge() : undefined
}

/** Memoize the pending origin lookup so concurrent requests share one IPC round trip. */
let pending: Promise<ApiClient> | null = null

export function getApiClient(): Promise<ApiClient> {
  // Discard rejected lookups so a transient shell startup failure can recover on the next request.
  pending ??= resolveOrigin()
    .then((origin) => createApiClient(origin))
    .catch((error: unknown) => {
      pending = null
      throw error
    })
  return pending
}

/** Clear the cached client when tests or server selection require a fresh origin lookup. */
export function resetApiClient(): void {
  pending = null
}

async function resolveOrigin(): Promise<string> {
  const connection = optionalBridge()
  if (!connection) {
    // Vite is a developer tool: use its explicit API target without native IPC.
    const devOrigin = import.meta.env.DEV ? (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').trim() : ''
    if (devOrigin) return devOrigin
    // Not a recoverable state: the renderer is running somewhere it was not
    // built to run (a plain browser tab, a preload that failed to load). Saying
    // so beats defaulting to `location.origin`, which would send every request
    // to the page's own dev server and produce 404s that look like a broken API.
    throw new ApiError({
      kind: 'bridge',
      method: 'IPC',
      path: 'app:get-backend-origin',
      message: 'the preload bridge is not present on this page',
    })
  }

  const answer = await connection.invoke('app:get-backend-origin', undefined)
  const origin = typeof answer?.origin === 'string' ? answer.origin.trim() : ''
  if (origin === '') {
    throw new ApiError({
      kind: 'bridge',
      method: 'IPC',
      path: 'app:get-backend-origin',
      message: 'main answered with no backend origin',
      body: answer,
    })
  }
  return origin
}
