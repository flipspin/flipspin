import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AACRanges } from './aac'
import { AACStream, type AACCodec } from './aacStream'
import { AACDecoder } from './aacDecoder'
const fixture = () => new Uint8Array(readFileSync(resolve(import.meta.dirname, 'fixtures/tone.m4a')))
let scope: { onmessage: (event: { data: Record<string, unknown> }) => void; postMessage: ReturnType<typeof vi.fn> }
let closes = 0, decodes = 0, dataCloses = 0
class TestAudioDecoder {
  static isConfigSupported = vi.fn(async () => ({ supported: true }))
  state = 'configured'
  constructor(private init: AudioDecoderInit) {}
  configure = vi.fn()
  decode(packet: EncodedAudioChunkInit) {
    decodes++
    const start = Math.round(packet.timestamp * 44100 / 1e6)
    this.init.output({
      timestamp: packet.timestamp, sampleRate: 44100, numberOfChannels: 2, numberOfFrames: 1024,
      copyTo: (channel: Float32Array) => { for (let i = 0; i < channel.length; i++) channel[i] = start + i },
      close: () => { dataCloses++ },
    } as unknown as AudioData)
  }
  flush = async () => {}
  close() { closes++; this.state = 'closed' }
}
const until = async (predicate: () => boolean) => {
  const start = performance.now()
  while (!predicate()) { if (performance.now() - start > 5000) throw new Error('Worker response timeout'); await new Promise(resolve => setTimeout(resolve, 1)) }
}
function media(data: Uint8Array) {
  const requests: number[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    const [, first, last] = /bytes=(\d+)-(\d+)/.exec(options.headers.Range)!
    const start = +first, end = Math.min(+last, data.length - 1); requests.push(start)
    expect(+last - start + 1).toBe(262144)
    return new Response(data.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${data.length}` } })
  }))
  return requests
}
beforeEach(async () => {
  vi.resetModules(); closes = 0; decodes = 0; dataCloses = 0
  TestAudioDecoder.isConfigSupported.mockReset().mockResolvedValue({ supported: true })
  vi.stubGlobal('AudioDecoder', TestAudioDecoder)
  vi.stubGlobal('EncodedAudioChunk', class { constructor(packet: EncodedAudioChunkInit) { Object.assign(this, packet) } })
  scope = { onmessage: () => {}, postMessage: vi.fn() }; vi.stubGlobal('self', scope)
  await import('./decoder.worker')
})
afterEach(() => vi.unstubAllGlobals())
async function send(data: object) {
  const from = scope.postMessage.mock.calls.length
  scope.onmessage({ data: { token: 1, id: 1, ...data } })
  await until(() => scope.postMessage.mock.calls.slice(from).some(([m]) => ['metadata', 'pulled', 'done', 'native', 'error'].includes(m.type)))
  const messages = scope.postMessage.mock.calls.slice(from).map(([m]) => m)
  expect(messages.find(m => m.type === 'error')).toBeUndefined()
  return messages
}
it('streams AAC under pull credit, applies trim once and closes every AudioData', async () => {
  media(fixture())
  const metadata = await send({ type: 'start', src: 'magic', seconds: 0, webCodecs: true, outputRate: 44100 })
  expect(metadata.at(-1)).toMatchObject({ type: 'metadata', decoderLocation: 'worker', info: { duration: .1, delay: 1024 } })
  expect(decodes).toBe(0)
  const messages = await send({ type: 'pull' }), pcm = messages.find(m => m.type === 'pcm')!
  expect(pcm.channels[0]).toHaveLength(4410)
  expect(pcm.channels[0][0]).toBe(1024); expect(pcm.channels[0].at(-1)).toBe(5433)
  expect(messages.at(-1).type).toBe('done'); expect(dataCloses).toBe(6); expect(closes).toBe(1)
})
it('seeks by sample bytes with one frame preroll and drops decoded prefix exactly', async () => {
  media(fixture())
  await send({ type: 'start', src: 'magic', seconds: 3072 / 44100, webCodecs: true, outputRate: 44100 })
  const messages = await send({ type: 'pull' }), pcm = messages.find(m => m.type === 'pcm')!
  expect(decodes).toBe(3) // samples 3072, 4096, 5120; target includes edit priming
  expect(pcm.channels[0]).toHaveLength(4410 - 3072)
  expect(pcm.channels[0][0]).toBe(4096)
})
it('uses nativePCM when the main capability is absent, even if the worker has WebCodecs', async () => {
  media(fixture())
  expect(await send({ type: 'start', src: 'magic', seconds: 0, webCodecs: false })).toContainEqual(expect.objectContaining({ type: 'native', adts: false }))
  expect(decodes).toBe(0)
})
it('uses nativePCM for ALAC, fragmented MP4, and unsupported AAC configs', async () => {
  const data = fixture(), alac = data.slice(); alac.set(new TextEncoder().encode('alac'), Buffer.from(alac).indexOf('mp4a'))
  media(alac)
  expect(await send({ type: 'start', src: 'alac', seconds: 0, webCodecs: true })).toContainEqual(expect.objectContaining({ type: 'native' }))
  const fragment = new Uint8Array(data.length + 8); fragment.set(data); new DataView(fragment.buffer).setUint32(data.length, 8); fragment.set(new TextEncoder().encode('moof'), data.length + 4)
  media(fragment)
  expect(await send({ type: 'start', src: 'fragmented', seconds: 0, webCodecs: true })).toContainEqual(expect.objectContaining({ type: 'native' }))
  media(data); TestAudioDecoder.isConfigSupported.mockResolvedValue({ supported: false })
  // Resolve the main-thread support probe negatively as well.
  const original = scope.postMessage
  original.mockImplementation(m => { if (m.type === 'aac') queueMicrotask(() => scope.onmessage({ data: { type: 'aacResult', request: m.request, value: false } })) })
  expect(await send({ type: 'start', src: 'unsupported', seconds: 0, webCodecs: true })).toContainEqual(expect.objectContaining({ type: 'native' }))
})
it('bridges to the main thread when AudioDecoder is absent in the worker', async () => {
  vi.stubGlobal('AudioDecoder', undefined); media(fixture())
  scope.postMessage.mockImplementation(m => {
    if (m.type !== 'aac' || !m.request) return
    const value = m.operation === 'supported' ? true : m.operation === 'decode' ? m.packets.map(p => ({ timestamp: p.timestamp, rate: 44100, channels: [new Float32Array(1024).fill(.5), new Float32Array(1024).fill(.5)] })) : undefined
    queueMicrotask(() => scope.onmessage({ data: { type: 'aacResult', request: m.request, value } }))
  })
  expect((await send({ type: 'start', src: 'magic', seconds: 0, webCodecs: true, outputRate: 44100 })).at(-1)).toMatchObject({ decoderLocation: 'main' })
  const pcm = (await send({ type: 'pull' })).find(m => m.type === 'pcm')!
  expect(pcm.channels[0]).toHaveLength(4410)
  expect(pcm.channels[0].every(v => v === .5)).toBe(true)
})
it('aborts a pending main-thread support request without blocking the next song', async () => {
  vi.stubGlobal('AudioDecoder', undefined); media(fixture())
  scope.onmessage({ data: { type: 'start', token: 1, id: 1, src: 'old', seconds: 0, webCodecs: true } })
  await until(() => scope.postMessage.mock.calls.some(([m]) => m.type === 'aac'))
  scope.onmessage({ data: { type: 'start', token: 2, id: 2, src: 'new', seconds: 0, webCodecs: false } })
  await until(() => scope.postMessage.mock.calls.some(([m]) => m.type === 'native' && m.id === 2))
  expect(scope.postMessage.mock.calls.some(([m]) => m.type === 'metadata' && m.id === 1)).toBe(false)
})
it('preserves all ADTS PCM, including first frame, and reports exact length at EOF', async () => {
  const frame = new Uint8Array(100); frame.set([255, 241, 80, 128, 12, 159, 252])
  const data = new Uint8Array(200); data.set(frame); data.set(frame, 100); media(data)
  await send({ type: 'start', src: 'adts', seconds: 0, webCodecs: true, outputRate: 44100 })
  const messages = await send({ type: 'pull' }), pcm = messages.find(m => m.type === 'pcm')!
  expect(pcm.channels[0]).toHaveLength(2048); expect(pcm.channels[0][0]).toBe(0)
  expect(messages.find(m => m.type === 'metadata').info).toMatchObject({ adts: true, delay: 0, totalSamples: 2048 })
})
it('caps each decode batch even for a large source and frees codecs on cancellation', async () => {
  // Streaming ADTS models a long encoded source with no pre-scan or full PCM allocation.
  const frame = new Uint8Array(100); frame.set([255, 241, 80, 128, 12, 159, 252])
  const data = new Uint8Array(100 * 30000)
  for (let at = 0; at < data.length; at += 100) data.set(frame, at)
  const requests = media(data)
  await send({ type: 'start', src: 'long', seconds: 0, webCodecs: true, outputRate: 44100 })
  const messages = await send({ type: 'pull' })
  expect(messages.find(m => m.type === 'pcm').channels[0]).toHaveLength(16 * 1024)
  expect(requests).toEqual([0]); expect(decodes).toBe(16)
  scope.onmessage({ data: { type: 'cancel', token: 2 } }); expect(closes).toBe(1)
})
it('handles bounded bridge output with trim before resampling', async () => {
  vi.stubGlobal('AudioDecoder', undefined)
  const data = fixture(), signal = new AbortController().signal, decoder = new AACDecoder()
  const fake: AACCodec = { supported: async () => true, open: async () => {}, close: () => decoder.close(), decode: async packets => packets.map(p => ({ timestamp: p.timestamp, rate: 44100, channels: [new Float32Array(1024).fill(1), new Float32Array(1024).fill(1)] })) }
  const stream = new AACStream(new AACRanges('fixture', signal, data, data.length), signal, 48000)
  expect(await stream.open(false, 0, fake)).toBe(true)
  const channels = await stream.read(); expect(channels[0]).toHaveLength(4800)
  expect(channels[0].every(v => Math.abs(v - 1) < 1e-6)).toBe(true)
})
