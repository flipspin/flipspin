import { afterEach, expect, it, vi } from 'vitest'
import { PollingEventSource } from '@lib/progressSource'
import { proxyFetch } from '@lib/apiAuth'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it('polls progress through Rust, delivers terminal snapshots and stops', async () => {
  vi.useFakeTimers()
  const requestBackend = vi.fn()
    .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ completed: 1, terminal: false }) })
    .mockResolvedValueOnce({ status: 200, body: JSON.stringify({ completed: 2, terminal: true }) })
  vi.stubGlobal('desktopAPI', { requestBackend })
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => proxyFetch(url, init, vi.fn()))
  const source = new PollingEventSource('http://localhost:8000/api/download-progress-stream/job?access_token=stale')
  const message = vi.fn()
  source.onmessage = message
  await vi.advanceTimersByTimeAsync(0)
  expect(message).toHaveBeenCalledTimes(1)
  expect(requestBackend.mock.calls[0][0].url).toBe('http://localhost:8000/api/download-progress/job')
  await vi.advanceTimersByTimeAsync(1000)
  expect(JSON.parse(message.mock.calls[1][0].data)).toEqual({ completed: 2, terminal: true })
  await vi.advanceTimersByTimeAsync(5000)
  expect(requestBackend).toHaveBeenCalledTimes(2)
  expect(source.readyState).toBe(2)
})
it('disposes in-flight snapshots and emits end when a job disappears', async () => {
  vi.useFakeTimers()
  let resolve!: (value: Response) => void
  const fetch = vi.fn(() => new Promise<Response>(r => { resolve = r }))
  vi.stubGlobal('fetch', fetch)
  const source = new PollingEventSource('http://localhost:8000/api/download-progress-stream/job')
  const message = vi.fn()
  source.onmessage = message
  await vi.advanceTimersByTimeAsync(0)
  source.close()
  resolve(new Response(JSON.stringify({ terminal: false })))
  await vi.advanceTimersByTimeAsync(1000)
  expect(message).not.toHaveBeenCalled()
  fetch.mockResolvedValue(new Response(null, { status: 404 }))
  const missing = new PollingEventSource(source.url)
  const end = vi.fn()
  missing.addEventListener('end', end)
  await vi.advanceTimersByTimeAsync(0)
  expect(end).toHaveBeenCalledOnce()
  expect(missing.readyState).toBe(2)
  await vi.advanceTimersByTimeAsync(5000)
  expect(fetch).toHaveBeenCalledTimes(2)
})
