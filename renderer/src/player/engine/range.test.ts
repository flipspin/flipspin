import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { range } from './range'
import { flush } from '../../stems/fakeAudio'

let fetcher: ReturnType<typeof vi.fn<typeof fetch>>
beforeEach(() => { vi.useFakeTimers(); fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
const slice = (offset: number, local = true) => new Response(new Uint8Array(4), { status: 206, headers: {
  'Content-Range': `bytes ${offset}-${offset + 3}/100`, ...(local ? { 'X-Krobi-Cache-Hit': 'true' } : {}),
} })
it('re-requests the same failed local slice after a 5 s mid-song stall', async () => {
  const signal = new AbortController().signal
  fetcher.mockResolvedValueOnce(slice(0))
  await range('song', 0, signal)
  fetcher.mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject(new TypeError('slow local read')), 5000)))
  fetcher.mockResolvedValueOnce(slice(4))
  let resumed = false
  const pending = range('song', 4, signal).then(result => { resumed = true; return result })
  await vi.advanceTimersByTimeAsync(5000)
  expect(resumed).toBe(false)
  await vi.advanceTimersByTimeAsync(1000)
  expect((await pending).bytes).toHaveLength(4)
  expect(fetcher.mock.calls.slice(1).map(call => call[1]?.headers)).toEqual([{ Range: 'bytes=4-262147' }, { Range: 'bytes=4-262147' }])
})
it('recovers a local request timeout and retries beyond the server budget with capped backoff', async () => {
  const controller = new AbortController()
  fetcher.mockResolvedValueOnce(slice(0))
  await range('song', 0, controller.signal)
  fetcher.mockImplementationOnce((_url, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('slow', 'AbortError')))))
  fetcher.mockRejectedValue(new TypeError('unreadable'))
  const pending = range('song', 4, controller.signal)
  const settled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.advanceTimersByTimeAsync(10001)
  for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) await vi.advanceTimersByTimeAsync(delay)
  expect(fetcher).toHaveBeenCalledTimes(8)
  controller.abort()
  await settled
  await vi.advanceTimersByTimeAsync(60000)
  expect(fetcher).toHaveBeenCalledTimes(8)
})
it('passes server failures to the existing controller and does not inherit a previous load provenance', async () => {
  fetcher.mockResolvedValueOnce(slice(0))
  await range('song', 0, new AbortController().signal)
  fetcher.mockRejectedValue(new TypeError('server unavailable'))
  await expect(range('song', 4, new AbortController().signal)).rejects.toMatchObject({ code: 2 })
  expect(fetcher).toHaveBeenCalledTimes(2)
})
it('cancels a local read in flight without retrying', async () => {
  const controller = new AbortController()
  fetcher.mockResolvedValueOnce(slice(0))
  await range('song', 0, controller.signal)
  fetcher.mockImplementationOnce((_url, init) => new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('cancel', 'AbortError')))))
  const pending = range('song', 4, controller.signal)
  const settled = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await flush(); controller.abort(); await settled
  await vi.advanceTimersByTimeAsync(60000)
  expect(fetcher).toHaveBeenCalledTimes(2)
})
