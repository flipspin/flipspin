import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlaybackEngine } from './PlaybackEngine'
import { deferred, flush } from '../../stems/fakeAudio'
import { TrackRing } from './ringBuffer'
import { SincResampler } from './resampler'
const state = vi.hoisted(() => ({ resume: () => Promise.resolve(), decodeAudioData: vi.fn() }))
vi.mock('../../stems/audioGraph', () => ({
  getAudioGraph: () => ({ context: { sampleRate: 44100, resume: () => state.resume(), decodeAudioData: state.decodeAudioData, audioWorklet: { addModule: async () => {} } }, analyser: {} }),
  setGraphVolume: vi.fn(),
}))
class Decoder {
  static instance: Decoder
  onmessage?: (event: { data: object }) => void
  postMessage = vi.fn()
  terminate = vi.fn()
  constructor() { Decoder.instance = this }
  reply(data: object) {
    const start = this.postMessage.mock.calls.map(call => call[0]).filter(m => m.type === 'start').at(-1)
    this.onmessage?.({ data: { token: start.token, id: start.id, ...data } })
  }
}
class Output {
  static instance: Output
  port = { postMessage: vi.fn(), close: vi.fn(), onmessage: undefined as ((event: { data: object }) => void) | undefined }
  connect = vi.fn()
  disconnect = vi.fn()
  constructor() { Output.instance = this }
  reply(data: object) {
    const reset = this.port.postMessage.mock.calls.map(call => call[0]).filter(m => m.type === 'reset').at(-1)
    this.port.onmessage?.({ data: { generation: reset.generation, ...data } })
  }
}
let engine: PlaybackEngine
const info = { sampleRate: 44100, bitrate: 320000, duration: 100, bytes: 4000000, audioOffset: 0, delay: 576, padding: 100 }
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Worker', Decoder); vi.stubGlobal('AudioWorkletNode', Output)
  state.resume = async () => {}; engine = new PlaybackEngine()
})
afterEach(() => { engine.dispose(); vi.useRealTimers(); vi.unstubAllGlobals() })
async function load() { engine.src = 'original.mp3'; engine.load(); await flush(); Decoder.instance.reply({ type: 'metadata', info }); await flush() }
describe('single engine transport and ownership', () => {
  it('counts the M4A exception and in-flight chunks in engine memory, then releases its AudioBuffer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(16), { status: 206, headers: { 'Content-Range': 'bytes 0-15/16' } })))
    state.decodeAudioData.mockResolvedValue({ length: 441000, sampleRate: 44100, numberOfChannels: 2, getChannelData: () => new Float32Array(441000).fill(.5) })
    engine.src = 'native.m4a'; engine.load(); await flush()
    Decoder.instance.reply({ type: 'native' }); await flush(); await flush()
    expect(engine.error).toBeNull()
    expect(engine.peakDecodedBytes).toBe(441000 * 2 * 4)
    expect(engine.decodedBytes).toBe(0)
    expect(engine.residentBytes).toBe(441000 * 2 * 4)
    expect(engine.peakResidentBytes).toBeGreaterThan(engine.residentBytes)
    engine.dispose(); expect(engine.residentBytes).toBe(0)
  })
  it('keeps a mixed-rate fake decoder queue on the output rate and inserts no zeros', async () => {
    await load(); await engine.play(); engine.setNext({ key: 'next', src: 'next.flac' })
    const ring = new TrackRing()
    const start = Decoder.instance.postMessage.mock.calls.find(call => call[0].type === 'start')[0]
    expect(start.outputRate).toBe(44100)
    Decoder.instance.reply({ type: 'pcm', rate: 44100, channels: [new Float32Array(441).fill(.5)] })
    Output.instance.reply({ type: 'clock', bytes: 0, tracks: [{ id: 1, played: 80 * 44100, frames: 0, rate: 44100 }] })
    Decoder.instance.reply({ type: 'done' })
    Decoder.instance.reply({ type: 'metadata', info: { ...info, sampleRate: 96000 }, rate: 44100 })
    const resampled = new SincResampler(96000, 44100).process([new Float32Array(960).fill(.5)], true)
    Decoder.instance.reply({ type: 'pcm', rate: 44100, channels: resampled })
    Decoder.instance.reply({ type: 'done' })
    for (const [message] of Output.instance.port.postMessage.mock.calls) {
      if (message.type === 'track') ring.add(message.id, message.rate)
      if (message.type === 'pcm') ring.push(message.id, message)
      if (message.type === 'done') ring.finish(message.id)
    }
    const output = [new Float32Array(882)]
    expect(ring.render(output, 44100, () => {})).toBe(882)
    expect(output[0].every(value => Math.abs(value - .5) < 1e-6)).toBe(true)
    expect(engine.duration).toBe(100)
  })
  it('routes a single output before the analyser, and bounds decoder credit including in-flight PCM', async () => {
    await load(); await engine.play()
    expect(Output.instance.connect).toHaveBeenCalledOnce()
    for (let n = 0; n < 20; n++) {
      Decoder.instance.reply({ type: 'pcm', rate: 44100, channels: [new Float32Array(44100), new Float32Array(44100)] })
      Decoder.instance.reply({ type: 'pulled' })
    }
    const pulls = Decoder.instance.postMessage.mock.calls.filter(call => call[0].type === 'pull').length
    Decoder.instance.reply({ type: 'pulled' })
    expect(Decoder.instance.postMessage.mock.calls.filter(call => call[0].type === 'pull')).toHaveLength(pulls)
    Output.instance.reply({ type: 'clock', bytes: 0, tracks: [{ id: 1, played: 44100, frames: 0, rate: 44100 }] })
    expect(Decoder.instance.postMessage.mock.calls.filter(call => call[0].type === 'pull')).toHaveLength(pulls + 1)
  })
  it('cancels pending play on pause, and drops old decoder/worklet events on seek', async () => {
    await load(); const resume = deferred<void>(); state.resume = () => resume.promise
    const playing = engine.play(); engine.pause(); resume.resolve(); await playing
    expect(engine.paused).toBe(true)
    const old = Decoder.instance.postMessage.mock.calls.find(call => call[0].type === 'start')[0]
    engine.currentTime = 42; await flush()
    Decoder.instance.onmessage?.({ data: { token: old.token, id: old.id, type: 'error', error: { code: 3 } } })
    expect(engine.currentTime).toBe(42); expect(engine.error).toBeNull()
  })
  it('switches stems on the same position and preserves paused intent through both directions', async () => {
    await load(); engine.currentTime = 42; await flush()
    const read = vi.fn((_start: number, frames: number) => Array.from({ length: 8 }, () => new Float32Array(frames)))
    engine.setStemSource({ duration: 100, sampleRate: 44100, read, levels: [1,1,1,0] }); await flush()
    expect(read.mock.calls[0][0]).toBe(42 * 44100)
    expect(engine.currentTime).toBe(42); expect(engine.paused).toBe(true)
    engine.setStemSource(null); await flush()
    const start = Decoder.instance.postMessage.mock.calls.filter(call => call[0].type === 'start').at(-1)![0]
    expect(start.seconds).toBe(42); expect(engine.paused).toBe(true)
  })
  it('promotes queued PCM without resetting output; reports measured boundaries, including underruns', async () => {
    await load(); await engine.play(); engine.setNext({ key: 'next', src: 'next.mp3' })
    // Current EOF is reached with its final <=30 s resident.
    Output.instance.reply({ type: 'clock', bytes: 0, tracks: [{ id: 1, played: 80 * 44100, frames: 0, rate: 44100 }] })
    Decoder.instance.reply({ type: 'done' })
    Decoder.instance.reply({ type: 'metadata', info })
    const boundaries: number[] = []
    engine.addEventListener('boundary', event => boundaries.push((event as CustomEvent).detail.ms))
    const resets = Output.instance.port.postMessage.mock.calls.filter(call => call[0].type === 'reset').length
    engine.addEventListener('ended', () => { engine.src = 'next.mp3'; engine.load() }, { once: true })
    Output.instance.reply({ type: 'end', id: 1, frame: 4410000, next: 2 })
    await flush()
    expect(Output.instance.port.postMessage.mock.calls.filter(call => call[0].type === 'reset')).toHaveLength(resets)
    Output.instance.reply({ type: 'boundary', gapFrames: 128, frame: 4410128 })
    expect(boundaries).toEqual([128 / 44100 * 1000])
  })
  it('drops and cancels an obsolete next head while preserving the current ring', async () => {
    await load(); await engine.play()
    engine.setNext({ key: 'next', src: 'next.mp3' })
    Output.instance.reply({ type: 'clock', bytes: 0, tracks: [{ id: 1, played: 80 * 44100, frames: 0, rate: 44100 }] })
    Decoder.instance.reply({ type: 'done' }); Decoder.instance.reply({ type: 'metadata', info })
    const old = Decoder.instance.postMessage.mock.calls.filter(call => call[0].type === 'start').at(-1)![0]
    engine.setNext({ key: 'other', src: 'other.mp3' })
    expect(Output.instance.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'drop', id: 2 }), [])
    Decoder.instance.onmessage?.({ data: { type: 'error', id: old.id, token: old.token, error: { code: 2, status: 404 } } })
    expect(engine.error).toBeNull()
    expect(Decoder.instance.postMessage.mock.calls.filter(call => call[0].type === 'start').at(-1)![0].src).toBe('other.mp3')
  })
  it('keeps next-head errors silent, and maps current network/decode/codec failures', async () => {
    await load(); const errors = vi.fn(), missing = vi.fn(); engine.addEventListener('error', errors)
    engine.addEventListener('trackMissing', missing)
    await engine.play(); engine.setNext({ key: 'next', src: 'next.mp3' })
    Output.instance.reply({ type: 'clock', bytes: 0, tracks: [{ id: 1, played: 80 * 44100, frames: 0, rate: 44100 }] })
    Decoder.instance.reply({ type: 'done' }); Decoder.instance.reply({ type: 'error', error: { code: 2, status: 404 } })
    expect(errors).not.toHaveBeenCalled()
    expect(missing).toHaveBeenCalledOnce()
    expect(missing.mock.calls[0][0].detail).toEqual({ key: 'next' })
    engine.currentTime = 10; await flush()
    Decoder.instance.reply({ type: 'error', error: { code: 2, status: 401 } })
    expect(engine.error).toMatchObject({ code: 2, status: 401 }); expect(errors).toHaveBeenCalledOnce()
  })

})
it('forwards sniffed ADTS metadata for native fallback and streamed PCM to the worklet', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(16), { status: 206, headers: { 'Content-Range': 'bytes 0-15/16' } })))
  state.decodeAudioData.mockResolvedValue({ length: 100, sampleRate: 44100, numberOfChannels: 2, getChannelData: () => new Float32Array(100) })
  engine.src = 'magic-only'; engine.load(); await flush()
  Decoder.instance.reply({ type: 'native', adts: true }); await flush(); await flush()
  expect(Output.instance.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'format', adts: true }), [])
  Decoder.instance.reply({ type: 'metadata', info: { ...info, adts: false }, decoderLocation: 'main' })
  expect(Output.instance.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'format', adts: false }), [])
  expect(engine.decoderLocation).toBe('main')
})
it('transfers main-thread WebCodecs PCM and suppresses a cancelled decode response', async () => {
  await load()
  const delayed = { pending: undefined as ReturnType<typeof deferred<void>> | undefined }
  const closeData = vi.fn()
  vi.stubGlobal('EncodedAudioChunk', class { constructor(packet: object) { Object.assign(this, packet) } })
  vi.stubGlobal('AudioDecoder', class {
    static isConfigSupported = async () => ({ supported: true })
    state = 'configured'
    constructor(private init: AudioDecoderInit) {}
    configure() {}
    decode() {
      this.init.output({ timestamp: 0, sampleRate: 44100, numberOfChannels: 1, numberOfFrames: 2,
        copyTo: (channel: Float32Array) => channel.fill(.5), close: closeData } as unknown as AudioData)
    }
    flush() { return delayed.pending?.promise || Promise.resolve() }
    close() { this.state = 'closed' }
  })
  const config = { codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 1 }
  Decoder.instance.reply({ type: 'aac', operation: 'supported', request: 1, config }); await flush()
  expect(Decoder.instance.postMessage).toHaveBeenCalledWith({ type: 'aacResult', request: 1, value: true }, [])
  Decoder.instance.reply({ type: 'aac', operation: 'open', request: 2, config }); await flush()
  const packets = [{ data: new Uint8Array(1), timestamp: 0, duration: 1000 }]
  Decoder.instance.reply({ type: 'aac', operation: 'decode', request: 3, packets }); await flush()
  expect(Decoder.instance.postMessage).toHaveBeenCalledWith({ type: 'aacResult', request: 3, value: [{ timestamp: 0, rate: 44100, channels: [new Float32Array([.5, .5])] }] }, [expect.any(ArrayBuffer)])
  expect(closeData).toHaveBeenCalledOnce()
  delayed.pending = deferred<void>()
  Decoder.instance.reply({ type: 'aac', operation: 'decode', request: 4, packets }); await flush()
  engine.currentTime = 42; delayed.pending.resolve(); await flush()
  expect(Decoder.instance.postMessage.mock.calls.some(([m]) => m.type === 'aacResult' && m.request === 4)).toBe(false)
})
