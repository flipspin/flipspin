import { afterEach, expect, it, vi } from 'vitest'
import { NativePCM } from './nativePCM'
import { deferred, flush } from '../../stems/fakeAudio'
afterEach(() => vi.unstubAllGlobals())
function media() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(16), { status: 206, headers: { 'Content-Range': 'bytes 0-15/16' } })))
}
const buffer = (frames = 441000) => ({ length: frames, sampleRate: 44100, numberOfChannels: 2, getChannelData: () => new Float32Array(frames).fill(.5) }) as unknown as AudioBuffer
it('budgets one decoded M4A at a time, seeks in samples and releases immediately after chunking', async () => {
  media()
  const source = new NativePCM(), signal = new AbortController().signal
  const context = { decodeAudioData: vi.fn(async () => buffer()) }
  await source.open('first', 2 / 44100, context, signal)
  expect(source.bytes).toBe(441000 * 2 * 4)
  const second = source.open('second', 0, context, signal)
  await flush(); expect(context.decodeAudioData).toHaveBeenCalledOnce()
  const chunk = source.read(441000)
  expect(chunk.channels[0]).toHaveLength(440998); expect(chunk.done).toBe(true)
  expect(source.bytes).toBe(0)
  await second; expect(context.decodeAudioData).toHaveBeenCalledTimes(2)
  expect(source.peakBytes).toBe(441000 * 2 * 4)
  source.read(441000); expect(source.bytes).toBe(0)
})
it('keeps the lease for an uncancellable native decode after seek cancellation', async () => {
  media()
  const source = new NativePCM(), old = new AbortController(), pending = deferred<AudioBuffer>()
  const context = { decodeAudioData: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(buffer(20)) }
  const first = source.open('old', 0, context, old.signal).catch(error => error)
  await flush(); old.abort(); source.close()
  const next = source.open('new', 0, context, new AbortController().signal)
  await flush(); expect(context.decodeAudioData).toHaveBeenCalledOnce()
  pending.resolve(buffer()); await first; await next
  expect(context.decodeAudioData).toHaveBeenCalledTimes(2)
  expect(source.bytes).toBe(20 * 2 * 4); source.close()
})
it('preserves HTTP status and releases the lease after a failed native fetch', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
  const source = new NativePCM()
  await expect(source.open('track', 0, { decodeAudioData: vi.fn() }, new AbortController().signal)).rejects.toMatchObject({ code: 2, status: 401 })
  expect(source.bytes).toBe(0); expect(source.encodedBytes).toBe(0)
})
