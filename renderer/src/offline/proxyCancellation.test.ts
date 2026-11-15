import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchBackend, requestBackend } from '../desktop/tauri'
import { bridge, setFakeBridgeForTest } from '../bridge'
import { installFakeBackend } from '../data/test-support'
import { loadLyrics, __resetLyricsStoreForTest } from '../lyrics/lyricsStore'
import { proxyFetch } from '../lib/apiAuth'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }))

let rejectRequest: (error: Error) => void
let finishRequest: (value: unknown) => void
beforeEach(() => {
  native.invoke.mockReset()
  native.invoke.mockImplementation((command, args) => {
    if (args?.channel === 'proxy:open') return Promise.resolve({ requestId: 'test-request' })
    if (args?.channel === 'proxy:cancel') {
      rejectRequest?.(new Error('proxy-request-cancelled'))
      return Promise.resolve({ ok: true })
    }
    if (command === 'backend_request') return new Promise((resolve, reject) => { finishRequest = resolve; rejectRequest = reject })
    throw new Error(`Unexpected command ${command}`)
  })
})
afterEach(() => vi.restoreAllMocks())

it('sends a native cancellation and waits for the cancelled request to settle', async () => {
  const controller = new AbortController()
  const request = requestBackend({ url: 'http://localhost:8000/api/status' }, controller.signal)
  const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('backend_request', { request: expect.objectContaining({ requestId: 'test-request' }) }))
  controller.abort()
  expect(native.invoke).toHaveBeenCalledWith('bridge_invoke', { channel: 'proxy:cancel', request: { requestId: 'test-request' } })
  await rejected
})

it('does not dispatch a pre-aborted request', async () => {
  await expect(requestBackend({}, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
  expect(native.invoke).not.toHaveBeenCalled()
})

it('cancels safely if abort happens while registration is being acknowledged', async () => {
  let opened!: (value: unknown) => void
  native.invoke.mockImplementationOnce(() => new Promise(resolve => { opened = resolve }))
  const controller = new AbortController()
  const request = requestBackend({}, controller.signal)
  const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  opened({ requestId: 'test-request' })
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('backend_request', expect.anything()))
  // Simulate Rust observing the already-cancelled registration on dispatch.
  rejectRequest(new Error('proxy-request-cancelled'))
  await rejected
})

it('removes its abort listener after success', async () => {
  const controller = new AbortController()
  const request = requestBackend({}, controller.signal)
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('backend_request', expect.anything()))
  finishRequest({ status: 200, body: '{}' })
  expect((await request).status).toBe(200)
  controller.abort()
  expect(native.invoke.mock.calls.filter(([, args]) => args?.channel === 'proxy:cancel')).toHaveLength(0)
})

it('kills the timeout-release hypothesis: legacy proxyFetch waits for native settlement', async () => {
  // The shipped fetch adapter checks abort only after requestBackend settles.
  // A renderer timeout must never race that promise and free a worker early.
  const prior = Object.getOwnPropertyDescriptor(window, 'desktopAPI')
  Object.defineProperty(window, 'desktopAPI', { configurable: true, value: { requestBackend } })
  try {
    const controller = new AbortController()
    let settled = false
    const request = proxyFetch('http://localhost:8000/api/status', { signal: controller.signal })
      .finally(() => { settled = true })
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('backend_request', expect.anything()))
    controller.abort()
    await Promise.resolve()
    expect(settled).toBe(false)
    finishRequest({ status: 200, body: '{}' })
    await rejected
  } finally {
    if (prior) Object.defineProperty(window, 'desktopAPI', prior)
    else delete window.desktopAPI
  }
})


it('carries a generated lyrics request signal through the bridge into Rust', async () => {
  const backend = installFakeBackend({ respond: () => { throw new Error('Lyrics must use the native transport') } })
  const restore = setFakeBridgeForTest({ ...bridge(), fetch: fetchBackend })
  try {
    const controller = new AbortController()
    const request = loadLyrics('Album/Cancelled.mp3', { signal: controller.signal })
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('backend_request', {
      request: expect.objectContaining({ url: expect.stringContaining('/api/lyrics/Album/Cancelled.mp3') }),
    }))
    controller.abort()
    expect(native.invoke).toHaveBeenCalledWith('bridge_invoke', { channel: 'proxy:cancel', request: { requestId: 'test-request' } })
    await rejected
  } finally { __resetLyricsStoreForTest(); restore(); backend.restore() }
})

it.each([200, 304])('preserves native status %i in the generated client transport', async status => {
  const request = fetchBackend(new Request('http://localhost:8000/api/status'))
  await vi.waitFor(() => expect(native.invoke).toHaveBeenCalledWith('backend_request', expect.anything()))
  finishRequest({ status, body: '{}', headers: { etag: '"test"' } })
  const response = await request
  expect(response.status).toBe(status)
  expect(response.headers.get('etag')).toBe('"test"')
  expect(await response.text()).toBe(status === 304 ? '' : '{}')
})
