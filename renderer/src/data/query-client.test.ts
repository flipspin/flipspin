/** Pin cache and retry policy so changes remain explicit. */

import { describe, expect, it } from 'vitest'

import { ApiError } from './errors'
import { createQueryClient, retryDelayFor, shouldRetryRequest } from './query-client'

function httpError(status: number): ApiError {
  return new ApiError({ kind: 'http', status, method: 'GET', path: '/api/me', message: 'boom' })
}

describe('shouldRetryRequest', () => {
  it('never retries a 4xx', () => {
    // 4xx refusals cannot recover by repeating the same request.
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(shouldRetryRequest(0, httpError(status))).toBe(false)
    }
  })

  it('retries a request that never got an answer, twice', () => {
    const offline = new ApiError({ kind: 'network', method: 'GET', path: '/api/status', message: 'boom' })

    // A local backend still binding its port, or a VPN coming back after a
    // laptop wakes; both resolve on their own within a second.
    expect(shouldRetryRequest(0, offline)).toBe(true)
    expect(shouldRetryRequest(1, offline)).toBe(true)
    expect(shouldRetryRequest(2, offline)).toBe(false)
  })

  it('retries a 5xx and gives up after the same two attempts', () => {
    expect(shouldRetryRequest(0, httpError(500))).toBe(true)
    expect(shouldRetryRequest(1, httpError(503))).toBe(true)
    expect(shouldRetryRequest(2, httpError(500))).toBe(false)
  })

  it('does not retry an answer this client cannot read', () => {
    // The server answered. Asking again gets the same unreadable body.
    const malformed = new ApiError({ kind: 'malformed', method: 'GET', path: '/api/status', message: 'boom' })
    expect(shouldRetryRequest(0, malformed)).toBe(false)
  })

  it('does not retry a missing preload bridge', () => {
    // The page is not running inside the shell. Waiting does not change that.
    const bridge = new ApiError({ kind: 'bridge', method: 'IPC', path: 'app:get-backend-origin', message: 'boom' })
    expect(shouldRetryRequest(0, bridge)).toBe(false)
  })

  it('retries an error it does not recognise', () => {
    // An unexpected throw is not evidence that retrying is pointless, and the
    // attempt cap bounds the cost of being wrong.
    expect(shouldRetryRequest(0, new Error('something else'))).toBe(true)
  })
})

describe('retryDelayFor', () => {
  it('stays short enough that the app does not look frozen', () => {
    expect(retryDelayFor(0)).toBe(400)
    expect(retryDelayFor(1)).toBe(800)
    // The library's own backoff climbs to 30 seconds, which on a desktop window
    // is indistinguishable from a hang.
    expect(retryDelayFor(9)).toBe(2_000)
  })
})

describe('createQueryClient', () => {
  it('gates queries on the shell connection through onlineManager', () => {
    const defaults = createQueryClient().getDefaultOptions()

    expect(defaults.queries?.networkMode).toBe('online')
    expect(defaults.mutations?.networkMode).toBe('always')
  })

  it('does not refetch every time the window regains focus', () => {
    const defaults = createQueryClient().getDefaultOptions()

    // A window open since Tuesday gains focus dozens of times an hour.
    expect(defaults.queries?.refetchOnWindowFocus).toBe(false)
    // Hello revisions own reconnect resync, avoiding a second refetch.
    expect(defaults.queries?.refetchOnReconnect).toBe(false)
  })

  it('keeps data fresh for half a minute and cached for half an hour', () => {
    const defaults = createQueryClient().getDefaultOptions()

    expect(defaults.queries?.staleTime).toBe(30_000)
    expect(defaults.queries?.gcTime).toBe(30 * 60_000)
  })

  it('never retries a write on its own', () => {
    // Almost nothing this backend writes is idempotent: a retry after an
    // ambiguous failure can apply a change twice while reporting failure.
    expect(createQueryClient().getDefaultOptions().mutations?.retry).toBe(false)
  })
})
