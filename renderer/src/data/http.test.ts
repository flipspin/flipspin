/** Fake fetch and the bridge so the production client and error normalization run in these tests. */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { apiGet, apiPost } from './http'
import { ApiError, isApiError, isForbidden, isNotFound, isUnauthorized, serverDetail } from './errors'
import { installFakeBackend, type FakeBackend } from './test-support'

const HANDSHAKE = {
  app: 'krobi',
  version: '2.1.2',
  instanceId: 'abc123',
  isInit: true,
  authMethods: ['token'],
}

let backend: FakeBackend | null = null

afterEach(() => {
  backend?.restore()
  backend = null
  vi.unstubAllEnvs()
})

describe('apiGet', () => {
  it('resolves with the body and sends the request to the resolved origin', async () => {
    backend = installFakeBackend({
      origin: 'http://192.168.1.10:8000',
      respond: () => ({ status: 200, json: HANDSHAKE }),
    })

    const body = await apiGet('/api/status')

    expect(body).toEqual(HANDSHAKE)
    // Resolve the origin from the bridge before sending the request.
    expect(backend.requests[0]?.url).toBe('http://192.168.1.10:8000/api/status')
  })

  it('serialises query parameters onto the URL', async () => {
    backend = installFakeBackend({ respond: () => ({ status: 200, json: [] }) })

    await apiGet('/api/listar-albums-con-metadata', { params: { query: { covers: false } } })

    // Load-bearing, not cosmetic: without `covers=false` this response is
    // ~32 MB instead of ~175 KB.
    expect(backend.requests[0]?.search).toBe('?covers=false')
  })

  it('turns a 401 into an ApiError that keeps its status', async () => {
    backend = installFakeBackend({
      respond: () => ({ status: 401, json: { detail: 'Invalid or missing API token' } }),
    })

    const error = await captureError(apiGet('/api/me'))

    expect(isApiError(error)).toBe(true)
    expect((error as ApiError).kind).toBe('http')
    expect((error as ApiError).status).toBe(401)
    expect(isUnauthorized(error)).toBe(true)
    expect(serverDetail(error)).toBe('Invalid or missing API token')
    // The sentence a screen renders is Spanish and says what to do about it.
    expect((error as ApiError).userMessage).toContain('iniciar sesión')
    // Never the token, never the URL: this string goes to the log stream.
    expect((error as ApiError).message).toBe('GET /api/me → 401 Unauthorized')
  })

  it('keeps 403 and 404 apart, in the status and in the sentence', async () => {
    // Preserve the distinction between permission denial and missing data.
    backend = installFakeBackend({
      respond: (request) =>
        request.pathname.endsWith('/mine')
          ? { status: 403, json: { detail: 'Playlist belongs to another user' } }
          : { status: 404, json: { detail: 'Playlist not found' } },
    })

    const forbidden = (await captureError(
      apiGet('/api/playlists/{name}', { params: { path: { name: 'mine' } } }),
    )) as ApiError
    const missing = (await captureError(
      apiGet('/api/playlists/{name}', { params: { path: { name: 'gone' } } }),
    )) as ApiError

    expect(forbidden.status).toBe(403)
    expect(missing.status).toBe(404)
    expect(isForbidden(forbidden)).toBe(true)
    expect(isNotFound(forbidden)).toBe(false)
    expect(isForbidden(missing)).toBe(false)
    expect(isNotFound(missing)).toBe(true)
    expect(forbidden.userMessage).not.toBe(missing.userMessage)
  })

  it('normalises a request that never got an answer', async () => {
    backend = installFakeBackend({ respond: () => ({ networkError: 'connect ECONNREFUSED' }) })

    const error = (await captureError(apiGet('/api/status'))) as ApiError

    expect(error.kind).toBe('network')
    // No status invented for a request that never had one.
    expect(error.status).toBeNull()
    expect(error.userMessage).toBe('No se pudo contactar con tu nido.')
  })

  it('separates an unreadable body from a network failure', async () => {
    backend = installFakeBackend({
      respond: () => ({ status: 200, text: '<!doctype html><title>proxy error</title>' }),
    })

    const error = (await captureError(apiGet('/api/status'))) as ApiError

    // A captive portal or a misconfigured proxy answers 200 with HTML. Retrying
    // gets the same HTML, which is why this cannot be filed as a network blip.
    expect(error.kind).toBe('malformed')
  })

  it('keeps a validation body whole rather than flattening it to a string', async () => {
    const detail = [{ loc: ['body', 'tracks', 0, 'path'], msg: 'field required', type: 'value_error.missing' }]
    backend = installFakeBackend({ respond: () => ({ status: 422, json: { detail } }) })

    const error = (await captureError(
      apiPost('/api/me/library', { body: { relPaths: [] } }),
    )) as ApiError

    expect(error.status).toBe(422)
    // A screen that wants to point at the offending field needs the array, so
    // the body is preserved as it arrived.
    expect(error.body).toEqual({ detail })
  })

  it('uses VITE_API_BASE_URL without a bridge in Vite development', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://dev-nest.test:8123')
    backend = installFakeBackend({ withoutBridge: true, respond: () => ({ status: 200, json: HANDSHAKE }) })
    expect(await apiGet('/api/status')).toEqual(HANDSHAKE)
    expect(backend.requests[0]?.url).toBe('http://dev-nest.test:8123/api/status')
  })

  it('requires the native bridge in production even with a Vite API target', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_API_BASE_URL', 'http://dev-nest.test:8123')
    backend = installFakeBackend({ withoutBridge: true, respond: () => ({ status: 200, json: HANDSHAKE }) })
    expect(((await captureError(apiGet('/api/status'))) as ApiError).kind).toBe('bridge')
    expect(backend.requests).toHaveLength(0)
  })

  it('reports a missing production preload bridge instead of guessing an origin', async () => {
    vi.stubEnv('DEV', false)
    backend = installFakeBackend({ withoutBridge: true, respond: () => ({ status: 200, json: {} }) })

    const error = (await captureError(apiGet('/api/status'))) as ApiError

    expect(error.kind).toBe('bridge')
    // Nothing was sent: defaulting to the page's own origin would have produced
    // a 404 that looks like a broken API.
    expect(backend.requests).toHaveLength(0)
  })

  it('rethrows an abort untouched so cancellation is not mistaken for failure', async () => {
    backend = installFakeBackend({ respond: () => ({ status: 200, json: HANDSHAKE }) })
    const controller = new AbortController()
    controller.abort()

    const error = await captureError(apiGet('/api/status', { signal: controller.signal }))

    // A user leaving a screen mid-load is not an error state. Wrapping this in
    // an ApiError would count a navigation as a retry and paint an error over a
    // screen nobody is looking at.
    expect(isApiError(error)).toBe(false)
    expect((error as Error).name).toBe('AbortError')
  })
})

async function captureError(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending
    throw new Error('expected the request to reject, and it resolved')
  } catch (error) {
    return error
  }
}
