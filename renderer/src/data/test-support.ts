/** Fake fetch and the native bridge so tests exercise URL building, parsing,
 * status handling and retries through the production data layer. */

import type { AuthIdentity, KrobiBridge } from '../lib/ipc'

import { serverStatus } from '../settings/test-support'
import { setFakeBridgeForTest } from '../bridge'
import { resetApiClient } from './backend'

/** What the fake server should answer, or how it should fail. */
export type ResponseSpec =
  | {
      status: number
      /** Serialised as JSON with a JSON content type. */
      json?: unknown
      /** Sent verbatim. Use this to answer with a body that is *not* valid JSON. */
      text?: string
      contentType?: string
    }
  /** The request never gets an answer: server down, cable out, VPN gone. */
  | { networkError: string }

export interface RecordedRequest {
  method: string
  /** The full URL as it left the process, query string included. */
  url: string
  pathname: string
  search: string
  headers: Record<string, string>
}

export interface FakeBackend {
  /** Every request that reached the network, in order. */
  requests: RecordedRequest[]
  /** How many requests hit a given pathname. */
  countFor: (pathname: string) => number
  /** Fire `auth:changed` at everything that subscribed through the fake bridge. */
  emitAuthChanged: (identity?: Partial<AuthIdentity>) => void
  restore: () => void
}

export interface FakeBackendOptions {
  origin?: string
  /** Answers a request. Returning nothing produces a 404, like a real server. */
  respond: (request: RecordedRequest) => ResponseSpec | undefined | Promise<ResponseSpec | undefined>
  /** Omit the preload bridge entirely, to exercise the "not running in the shell" path. */
  withoutBridge?: boolean
}

export function installFakeBackend(options: FakeBackendOptions): FakeBackend {
  const origin = options.origin ?? 'http://127.0.0.1:8000'
  const requests: RecordedRequest[] = []
  const authListeners: ((identity: AuthIdentity) => void)[] = []

  const previousFetch = globalThis.fetch
  let removeBridge: (() => void) | null = null

  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    // A real fetch rejects immediately on an aborted signal and never touches
    // the network. A fake that ignored it would let a test "prove" cancellation
    // handling against a request that was never cancelled.
    const signal = typeof input === 'string' ? undefined : (input as Request).signal
    if (signal?.aborted) throw abortError()

    const request = describe(input)
    requests.push(request)

    const spec = (await options.respond(request)) ?? { status: 404, json: { detail: 'Not Found' } }
    if ('networkError' in spec) {
      // A failed fetch rejects with a TypeError; matching the platform matters,
      // because the code under test branches on what it caught.
      throw new TypeError(spec.networkError)
    }

    const body = spec.text ?? (spec.json === undefined ? '' : JSON.stringify(spec.json))
    const contentType = spec.contentType ?? (spec.text === undefined ? 'application/json' : 'text/plain')
    return new Response(body === '' ? null : body, {
      status: spec.status,
      // Real servers send a reason phrase and the fake constructor does not
      // invent one, so an assertion on a log line would otherwise be testing a
      // gap in the fake rather than the code.
      statusText: STATUS_TEXT[spec.status] ?? '',
      headers: { 'content-type': contentType },
    })
  }) as typeof globalThis.fetch

  if (!options.withoutBridge) {
    // Use the bridge override's undo function so fakes cannot leak between tests.
    const fake: KrobiBridge = {
      invoke: (async (channel: string) => {
        if (channel === 'offline:sync') return { ok: true }
        if (channel === 'offline:snapshot') return undefined
        if (channel === 'offline:mode') return { forced: false }
        if (channel === 'offline:outbox') return []
        if (channel === 'offline:status') return { tracks: [], pins: 0, files: 0, bytes: 0 }
        if (channel === 'server:get-status') return serverStatus()
        if (channel === 'app:get-backend-origin') return { origin }
        if (channel === 'server:probe') {
          try {
            const response = await globalThis.fetch(`${origin}/api/status`)
            if (!response.ok) return { ok: false, reason: 'not-our-server' }
            return { ok: true, url: origin, handshake: await response.json() }
          } catch {
            return { ok: false, reason: 'unreachable' }
          }
        }
        throw new Error(`the fake bridge has no handler for ${channel}`)
      }) as KrobiBridge['invoke'],
      on: ((channel: string, listener: (payload: never) => void) => {
        if (channel !== 'auth:changed') return () => {}
        const typed = listener as unknown as (identity: AuthIdentity) => void
        authListeners.push(typed)
        return () => {
          const at = authListeners.indexOf(typed)
          if (at >= 0) authListeners.splice(at, 1)
        }
      }) as KrobiBridge['on'],
    }
    removeBridge = setFakeBridgeForTest(fake)
  }

  // Reset the memoized client so test order cannot select the previous fixture's origin.
  resetApiClient()

  return {
    requests,
    countFor: (pathname) => requests.filter((request) => request.pathname === pathname).length,
    emitAuthChanged: (identity) => {
      const payload: AuthIdentity = {
        userId: null,
        label: null,
        role: null,
        hasToken: false,
        ...identity,
      }
      for (const listener of [...authListeners]) listener(payload)
    },
    restore: () => {
      globalThis.fetch = previousFetch
      removeBridge?.()
      resetApiClient()
    },
  }
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
}

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError')
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function describe(input: unknown): RecordedRequest {
  const request = input as Request
  const url = new URL(typeof input === 'string' ? input : request.url)
  const headers: Record<string, string> = {}
  if (typeof input !== 'string' && request.headers) {
    request.headers.forEach((value, key) => {
      headers[key] = value
    })
  }
  return {
    method: typeof input === 'string' ? 'GET' : request.method,
    url: url.toString(),
    pathname: url.pathname,
    search: url.search,
    headers,
  }
}
