import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { deferred, flush } from '../../stems/fakeAudio'
const decoder = vi.hoisted(() => ({ creates: 0, ready: Promise.resolve(), reset: vi.fn(async () => {}), decode: vi.fn(() => ({ channelData: [new Float32Array(100), new Float32Array(100)], samplesDecoded: 100, sampleRate: 44100, errors: [] as { message: string }[] })) }))
vi.mock('mpg123-decoder', () => ({ MPEGDecoder: class {
  ready = decoder.ready; reset = decoder.reset; decode = decoder.decode
  constructor(options: { enableGapless: boolean }) { expect(options.enableGapless).toBe(true); decoder.creates++ }
} }))
let scope: { onmessage: (event: { data: object }) => void; postMessage: ReturnType<typeof vi.fn> }
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>
let token: number
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); token = 1; decoder.creates = 0; decoder.ready = Promise.resolve(); decoder.reset.mockClear(); decoder.decode.mockClear()
  scope = { onmessage: () => {}, postMessage: vi.fn() }; vi.stubGlobal('self', scope)
  fetcher = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', fetcher)
  await import('./decoder.worker')
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
const send = async (data: object) => { scope.onmessage({ data: { token, id: token, ...data } }); await flush() }
function media(size: number) {
  const bytes = new Uint8Array(size); bytes.set([255,251,224,0])
  fetcher.mockImplementation(async (_url, init) => {
    const [, first, last] = /bytes=(\d+)-(\d+)/.exec((init!.headers as Record<string,string>).Range)!
    const start = Number(first), end = Math.min(Number(last), size - 1)
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${size}`, 'X-Cache': 'HIT', 'X-Request-ID': 'request-fixture' } })
  })
}
it('fetches bounded ranges, transfers PCM under pull credit, and reuses one decoder across songs', async () => {
  media(130000)
  for (let song = 0; song < 2; song++) {
    const count = decoder.decode.mock.calls.length
    await send({ type: 'start', src: 'song.mp3', seconds: 0 })
    expect(decoder.decode).toHaveBeenCalledTimes(count)
    for (let pull = 0; pull < 34; pull++) await send({ type: 'pull' })
    expect(scope.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'done', id: token }), undefined)
    token++
  }
  expect(decoder.creates).toBe(1); expect(decoder.reset).toHaveBeenCalledTimes(2)
  for (const call of fetcher.mock.calls) {
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec((call[1]!.headers as Record<string,string>).Range)!
    expect(Number(end) - Number(start) + 1).toBeLessThanOrEqual(1048576)
  }
  const pcm = scope.postMessage.mock.calls.find(call => call[0].type === 'pcm')!
  expect(pcm[1]).toHaveLength(2)
  expect(scope.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'firstByte', cacheHit: true, requestId: 'request-fixture', receivedAt: expect.any(Number) }), undefined)
})
it.each([401,404,410,503])('preserves real fetch HTTP %i without misclassifying it as decode', async status => {
  fetcher.mockResolvedValue(new Response(null, { status }))
  await send({ type: 'start', src: 'song.mp3', seconds: 0 })
  expect(scope.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', error: expect.objectContaining({ code: 2, status }) }), undefined)
})
it('maps non-MP3 to unsupported and decoder failures to decode', async () => {
  fetcher.mockResolvedValue(new Response(new TextEncoder().encode('OggS wrong codec'), { status: 200, headers: { 'Content-Length': '16' } }))
  await send({ type: 'start', src: 'song.ogg', seconds: 0 })
  expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error', error: expect.objectContaining({ code: 4 }) }), undefined)
  token++; media(4096); await send({ type: 'start', src: 'song.mp3', seconds: 0 })
  decoder.decode.mockImplementationOnce(() => { throw new Error('bad frame') })
  await send({ type: 'pull' })
  expect(scope.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error', error: expect.objectContaining({ code: 3 }) }), undefined)
})
it('aborts a skipped fetch and ignores its late response', async () => {
  let signal: AbortSignal | null | undefined, resolve!: (response: Response) => void
  fetcher.mockImplementation((_url, init) => { signal = init?.signal; return new Promise(done => { resolve = done }) })
  await send({ type: 'start', src: 'old.mp3', seconds: 0 })
  token++; await send({ type: 'cancel' }); expect(signal?.aborted).toBe(true)
  resolve(new Response(new Uint8Array(4))); await flush()
  expect(scope.postMessage).not.toHaveBeenCalled()
})

it('cancels a song waiting for WASM initialization before it can fetch', async () => {
  vi.resetModules()
  const compilation = deferred<void>(); decoder.ready = compilation.promise
  await import('./decoder.worker')
  media(4096)
  await send({ type: 'start', src: 'old.mp3', seconds: 0 })
  token++; await send({ type: 'start', src: 'new.mp3', seconds: 0 })
  compilation.resolve(); await flush()
  expect(fetcher).toHaveBeenCalledOnce()
  expect(fetcher.mock.calls[0][0]).toBe('new.mp3')
})

it('keeps the decoder alive across a failed local slice after a 5 s mid-song stall', async () => {
  media(600000)
  const serve = fetcher.getMockImplementation()!
  let stalled = false
  fetcher.mockImplementation((url, init) => {
    if (!stalled && (init?.headers as Record<string, string>).Range.startsWith('bytes=262144-')) {
      stalled = true
      return new Promise((_, reject) => setTimeout(() => reject(new TypeError('slow local slice')), 5000))
    }
    return serve(url, init)
  })
  await send({ type: 'start', src: 'song.mp3', seconds: 0 })
  for (let pull = 0; pull < 65; pull++) await send({ type: 'pull' })
  expect(stalled).toBe(true)
  const frames = () => scope.postMessage.mock.calls.filter(call => call[0].type === 'pcm').length
  const before = frames()
  expect(before).toBeGreaterThan(0)
  await vi.advanceTimersByTimeAsync(5000)
  expect(frames()).toBe(before)
  await vi.advanceTimersByTimeAsync(1000)
  expect(frames()).toBeGreaterThan(before)
  expect(decoder.reset).toHaveBeenCalledTimes(1)
  expect(scope.postMessage.mock.calls.some(call => call[0].type === 'error')).toBe(false)
})
