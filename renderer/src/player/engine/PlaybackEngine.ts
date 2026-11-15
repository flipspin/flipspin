import { getVolume } from '../volumeStore'
import outputURL from './output.worklet.ts?worker&url'
import { getAudioGraph, setGraphVolume } from '../../stems/audioGraph'
import type { PlaybackPort, StemSource } from './PlaybackPort'
import { audioInfo, type AudioInfo } from './formats'
import { NativePCM } from './nativePCM'
import { AACDecoder, type AACPacket } from './aacDecoder'
import { engineError } from './mp3'
import { BUFFER_SECONDS } from './ringBuffer'
import { NowPlayingAnchor } from './nowPlayingAnchor'
import { log } from '../../lib/log'
interface Track {
  id: number; src: string; info?: AudioInfo; buffered: number; sent: number
  played: number; rate: number; done: boolean; offset: number
  key?: string
  channels?: number
}
interface ClockTrack { id: number; frames: number; played: number; rate: number }
/** The sole output owner. Decoder credit includes PCM in flight to the worklet. */
export class PlaybackEngine extends EventTarget implements PlaybackPort {
  /** Keeps macOS Now Playing (and so the media keys) while the worklet plays. */
  private anchor = new NowPlayingAnchor()
  src = ''
  duration = 0
  paused = true
  ended = false
  error: PlaybackPort['error'] = null
  private seconds = 0
  private node?: AudioWorkletNode
  private worker?: Worker
  private opening?: Promise<void>
  private generation = 0
  private token = 0
  private serial = 0
  private tracks: Track[] = []
  private decoding?: Track
  private busy = false
  private next: { key: string; src: string; cached?: boolean } | null = null
  private promoted?: Track
  private source?: StemSource
  private sourceFrame = 0
  private seekPending = false
  private lastUpdate = 0
  private positionAt = 0
  private audible = false
  private playIntent = 0
  private lifetime = 0
  private aacDecoder = new AACDecoder()
  /** Measurement only: records which global exposed the selected decoder. */
  decoderLocation: 'worker' | 'main' | 'native' | undefined
  private native = new NativePCM()
  private nativeController = new AbortController()
  private nativeTrack?: Track
  private decoderBytes = 0
  private peakResident = 0
  /** Native exception is additive to rings, including encoded bytes during fetch. */
  get decodedBytes() { return this.native.bytes }
  get peakDecodedBytes() { return this.native.peakBytes }
  get residentBytes() { return this.tracks.reduce((sum, track) => sum + Math.ceil(track.buffered) * (track.channels || 2) * 4, 0) + this.native.bytes + this.native.encodedBytes + this.decoderBytes }
  get peakResidentBytes() { return Math.max(this.peakResident, this.residentBytes) }
  /** Worklet-resident bytes, exposed for local measurement when heap metrics are unavailable. */
  bufferedBytes = 0
  get outputNode() { return this.node }
  get currentTime() {
    // Interpolate between worklet clock reports, bounded by the last credit.
    const track = this.tracks[0]
    return Math.min(this.duration || Infinity, this.seconds + (!this.paused && this.audible && track ? Math.min(track.buffered / track.rate, Math.max(0, performance.now() - this.positionAt) / 1000) : 0))
  }
  set currentTime(value: number) {
    if (!Number.isFinite(value) || !this.src) return
    const seconds = Math.max(0, Math.min(this.duration || value, value))
    this.emit('seeking'); this.seekPending = true
    this.restart(seconds)
  }
  get volume() { return getVolume() }
  set volume(value: number) { setGraphVolume(value); this.emit('volumechange') }
  private emit(name: string, detail?: unknown) { this.dispatchEvent(new CustomEvent(name, { detail })) }
  activate = async () => {
    const resume = getAudioGraph().context.resume()
    await this.ensureOutput(); await resume
  }
  private ensureOutput() {
    return this.opening ??= (async () => {
      const lifetime = this.lifetime
      const { context, analyser } = getAudioGraph()
      await context.audioWorklet.addModule(outputURL)
      if (lifetime !== this.lifetime) return
      this.node = new AudioWorkletNode(context, 'krobi-playback', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
      this.node.connect(analyser)
      this.node.onprocessorerror = () => this.fail(engineError('decode', 0, 'Output processor failure'))
      this.node.port.onmessage = ({ data }) => this.outputMessage(data)
      this.resetOutput()
      this.worker = new Worker(new URL('./decoder.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = ({ data }) => this.decoderMessage(data)
      this.worker.onerror = () => this.fail(engineError('decode'))
    })()
  }
  load() {
    this.playIntent++
    this.error = null; this.ended = false
    if (this.promoted?.src === this.src) {
      const track = this.promoted; this.promoted = undefined
      this.duration = track.info?.duration || 0
      this.seconds = track.played / track.rate; this.positionAt = performance.now()
      this.emit('loadstart')
      const generation = this.generation
      queueMicrotask(() => {
        if (generation !== this.generation) return
        this.emit('durationchange'); this.emit('loadedmetadata')
        if (track.buffered > 0) {
          this.emit('canplay')
          if (!this.paused && this.audible) this.emit('playing')
        }
      })
      return
    }
    this.promoted = undefined; this.changeSource(undefined, 'track-load')
    this.duration = 0; this.paused = true; this.emit('emptied')
    this.restart(0); this.emit('loadstart')
  }
  private restart(seconds: number) {
    this.cancelNative()
    const info = this.tracks.find(track => track.src === this.src)?.info
    this.seconds = seconds; this.positionAt = performance.now(); this.audible = false
    this.ended = false; this.generation++; this.token++; this.busy = false
    this.tracks = []; this.decoding = undefined
    const track: Track = { id: ++this.serial, src: this.src, info, buffered: 0, sent: 0, played: 0, rate: this.source?.sampleRate || info?.sampleRate || 44100, done: false, offset: seconds }
    this.tracks.push(track)
    this.resetOutput()
    const generation = this.generation
    void this.ensureOutput().then(() => {
      if (generation !== this.generation) return
      this.worker!.postMessage({ type: 'cancel', token: this.token })
      this.send({ type: 'track', id: track.id, rate: track.rate, levels: this.source?.levels })
      if (this.source) { this.sourceFrame = Math.round(seconds * track.rate); this.fillSource() }
      else this.startDecode(track)
    }).catch(error => this.fail(engineError('decode', 0, String(error))))
  }
  private resetOutput() {
    this.send({ type: 'reset' }); this.send({ type: 'run', value: !this.paused })
  }
  private send(data: object, transfer?: Transferable[]) { this.node?.port.postMessage({ ...data, generation: this.generation }, transfer || []) }
  private startDecode(track: Track) {
    this.decoderBytes = 0
    this.decoding = track; this.busy = true; this.token++
    this.worker!.postMessage({ type: 'start', token: this.token, id: track.id, src: track.src, seconds: track.offset, info: track.info, outputRate: getAudioGraph().context.sampleRate, webCodecs: typeof AudioDecoder !== 'undefined' })
  }
  async play() {
    const generation = this.generation
    const intent = ++this.playIntent
    await this.activate()
    if (generation !== this.generation || intent !== this.playIntent) return
    this.paused = false; this.ended = false
    this.anchor.play()
    this.send({ type: 'run', value: true }); this.emit('play')
    if (this.audible) this.emit('playing')
    this.pump()
  }
  pause() {
    this.playIntent++
    this.seconds = this.currentTime; this.positionAt = performance.now()
    this.paused = true; this.anchor.pause(); this.send({ type: 'run', value: false }); this.emit('pause')
  }
  setNext(track: { key: string; src: string; cached?: boolean } | null) {
    this.next = track
    const queued = this.tracks[1]
    if (queued && queued.src !== track?.src) {
      this.send({ type: 'drop', id: queued.id }); this.tracks.pop()
      if (this.decoding === queued) { this.cancelNative(); this.token++; this.worker?.postMessage({ type: 'cancel', token: this.token }); this.decoding = undefined; this.busy = false }
    }
    this.pump()
  }
  /** Stems are PCM sources. Switching retains the transport clock and intent. */
  setStemSource(source: StemSource | null, reason = source ? 'stems-ready' : 'original') {
    // Source handoffs preserve pause intent, but a running transport must also
    // recover a context suspended by the platform while stems were loading.
    if (!this.paused) void this.activate().catch(error => this.fail(engineError('decode', 0, String(error))))
    if (!source && !this.source) return
    const seconds = this.currentTime
    this.changeSource(source || undefined, reason)
    this.restart(seconds)
  }
  private changeSource(source: StemSource | undefined, reason: string) {
    if (!!source !== !!this.source) log.playback.debug('output ownership changed', { from: this.source ? 'stems' : 'engine', to: source ? 'stems' : 'engine', reason })
    this.source = source
  }
  setStemLevels(levels: number[]) {
    // Mix actions precede async stem decoding. Never turn the original's
    // two-channel ring into an eight-channel stem ring in that interval.
    if (!this.source) return
    this.source.levels = levels
    this.send({ type: 'levels', id: this.tracks[0]?.id, levels })
  }
  private fillSource() {
    const track = this.tracks[0], source = this.source
    if (!source || !track) return
    const total = Math.round(source.duration * source.sampleRate)
    while (track.buffered < 10 * track.rate && this.sourceFrame < total) {
      const frames = Math.min(track.rate, total - this.sourceFrame)
      const channels = source.read(this.sourceFrame, frames)
      this.sourceFrame += frames; track.buffered += frames; track.sent += frames
      this.send({ type: 'pcm', id: track.id, channels, rate: track.rate }, channels.map(channel => channel.buffer as ArrayBuffer))
    }
    if (this.sourceFrame >= total && !track.done) { track.done = true; this.send({ type: 'done', id: track.id }) }
    if (this.seekPending) { this.seekPending = false; this.emit('seeked') }
    this.emit('canplay')
  }
  private pump() {
    // Stems feed the current ring; the worker can still decode the next head.
    if (this.source) this.fillSource()
    const current = this.tracks[0]
    if (!current || !this.worker) return
    if (!this.decoding && current.done && this.next && !this.tracks[1] && !this.paused && this.duration - this.currentTime <= 30) {
      const track: Track = { id: ++this.serial, key: this.next.key, src: this.next.src, buffered: 0, sent: 0, played: 0, rate: 44100, done: false, offset: 0 }
      this.tracks.push(track); this.send({ type: 'track', id: track.id, rate: track.rate }); this.startDecode(track)
    }
    const track = this.decoding
    // 4 KiB decode ≤ 4.1 s even at the minimum Layer III bitrate (8 kbit/s).
    // Keep ten seconds of credit for that one in-flight result.
    const target = track === current ? BUFFER_SECONDS - 10 : 11
    if (track && !this.busy && track.buffered / track.rate < target) {
      this.busy = true
      if (this.nativeTrack === track) {
        const { channels, done } = this.native.read(track.rate)
        if (channels[0]?.length) this.decoderMessage({ type: 'pcm', token: this.token, id: track.id, channels, rate: track.rate })
        if (done) this.nativeTrack = undefined
        this.decoderMessage({ type: done ? 'done' : 'pulled', token: this.token, id: track.id })
      } else this.worker.postMessage({ type: 'pull', token: this.token, id: track.id })
    }
  }
  private cancelNative() {
    this.aacDecoder.close()
    this.nativeController.abort(); this.nativeController = new AbortController()
    this.native.close(); this.nativeTrack = undefined; this.decoderBytes = 0
  }
  private async startNative(track: Track) {
    const token = this.token, signal = this.nativeController.signal
    try {
      const decoded = await this.native.open(track.src, track.offset, getAudioGraph().context, signal)
      if (signal.aborted || token !== this.token) return
      this.nativeTrack = track
      this.peakResident = Math.max(this.peakResident, this.residentBytes)
      this.decoderMessage({ type: 'metadata', token, id: track.id, info: { ...audioInfo('native', decoded.sampleRate, decoded.frames, 0), adts: track.info?.adts }, rate: decoded.sampleRate })
    } catch (error) {
      if (!signal.aborted && token === this.token) this.decoderMessage({ type: 'error', token, id: track.id, error: { ...engineError('decode'), ...error as object } })
    }
  }
  private decoderMessage(m: { type: string; token: number; id: number; info?: AudioInfo; channels?: Float32Array[]; rate?: number; error?: PlaybackPort['error']; [key: string]: unknown }) {
    if (m.token !== this.token) return
    const track = this.tracks.find(track => track.id === m.id)
    if (!track) return
    if (m.type === 'memory') { this.decoderBytes = Number(m.bytes); this.peakResident = Math.max(this.peakResident, this.residentBytes); return }
    if (m.type === 'aac') { void this.aacMessage(m); return }
    if (m.type === 'native') {
      this.decoderLocation = 'native'
      track.info = { ...track.info, adts: m.adts === true } as AudioInfo
      void this.startNative(track); return
    }
    if (m.type === 'firstByte') this.emit('firstByte', { cacheHit: m.cacheHit, requestId: m.requestId, t: Number(m.receivedAt) - performance.timeOrigin, src: track.src })
    if (m.type === 'metadata') {
      if (m.decoderLocation) this.decoderLocation = m.decoderLocation as 'worker' | 'main'
      this.send({ type: 'format', id: track.id, adts: m.info?.adts === true })
      track.info = m.info; track.rate = m.rate || m.info!.sampleRate
      if (track === this.tracks[0]) {
        this.duration = m.info!.duration; this.emit('durationchange'); this.emit('loadedmetadata')
        if (m.token !== this.token) return
      }
      this.busy = false
    }
    if (m.type === 'pcm') {
      const channels = m.channels!, frames = channels[0].length
      track.buffered += frames; track.sent += frames; track.rate = m.rate!; track.channels = channels.length
      this.peakResident = Math.max(this.peakResident, this.residentBytes)
      this.send({ type: 'pcm', id: track.id, channels, rate: track.rate }, channels.map(channel => channel.buffer as ArrayBuffer))
      if (track === this.tracks[0]) {
        this.emit('canplay')
        if (this.seekPending) { this.seekPending = false; this.emit('seeked') }
      }
    }
    if (m.type === 'pulled') this.busy = false
    if (m.type === 'done') {
      track.done = true; this.send({ type: 'done', id: track.id }); this.decoding = undefined; this.busy = false
      if (track === this.tracks[0] && this.seekPending) { this.seekPending = false; this.emit('seeked') }
    }
    if (m.type === 'error') {
      this.decoding = undefined; this.busy = false
      if (track === this.tracks[0]) this.fail(m.error!)
      else {
        this.send({ type: 'drop', id: track.id }); this.tracks.pop(); this.next = null
        if (track.key && (m.error?.status === 404 || m.error?.status === 410)) this.emit('trackMissing', { key: track.key })
      }
    }
    this.pump()
  }
  private async aacMessage(m: { token: number; [key: string]: unknown }) {
    const own = m.token
    try {
      let value: unknown
      if (m.operation === 'supported') value = await AACDecoder.supported(m.config as AudioDecoderConfig)
      if (m.operation === 'open') this.aacDecoder.open(m.config as AudioDecoderConfig)
      if (m.operation === 'decode') value = await this.aacDecoder.decode(m.packets as AACPacket[])
      if (m.operation === 'close') this.aacDecoder.close()
      if (own === this.token && m.request) {
        const transfer = Array.isArray(value) ? value.flatMap(block => block.channels.map((c: Float32Array) => c.buffer as ArrayBuffer)) : []
        this.worker?.postMessage({ type: 'aacResult', request: m.request, value }, transfer)
      }
    } catch (error) {
      if (own === this.token) this.worker?.postMessage({ type: 'aacResult', request: m.request, error: String(error) })
    }
  }
  private outputMessage(m: { type: string; generation: number; tracks?: ClockTrack[]; bytes?: number; id?: number; next?: number; frame?: number; audioFrame?: number; gapFrames?: number; from?: number }) {
    if (m.generation !== this.generation) return
    if (m.type === 'clock') {
      this.bufferedBytes = m.bytes!
      for (const clock of m.tracks!) {
        const track = this.tracks.find(t => t.id === clock.id)
        if (!track) continue
        track.played = clock.played
        // Subtract consumed frames from all sent frames, including port messages in flight.
        track.buffered = Math.max(0, track.sent - Math.floor(clock.played))
        if (track === this.tracks[0]) { this.seconds = track.offset + track.played / track.rate; this.positionAt = performance.now() }
      }
      const now = performance.now()
      if (now - this.lastUpdate >= 250) { this.lastUpdate = now; this.emit('timeupdate') }
      this.pump()
    }
    if (m.type === 'playing' || m.type === 'waiting') {
      this.audible = m.type === 'playing'; this.positionAt = performance.now()
      if (!this.paused && !this.ended) this.emit(m.type, m)
    }
    if (m.type === 'boundary') this.emit('boundary', { ms: m.gapFrames! / getAudioGraph().context.sampleRate * 1000, frame: m.frame, audioFrame: m.audioFrame })
    if (m.type === 'end') {
      const track = this.tracks.find(t => t.id === m.id)
      if (!track) return
      this.seconds = track.info?.duration || this.duration
      // Ownership belongs to the ended track, never to the promoted original.
      // Clear it before ended listeners or queued level changes can run.
      this.changeSource(undefined, 'track-ended')
      this.tracks.shift()
      const next = this.tracks[0]
      this.promoted = next
      if (next) this.next = null
      else { this.ended = true; this.audible = false; this.anchor.pause() }
      this.emit('ended', m)
      this.pump()
    }
  }
  private fail(error: NonNullable<PlaybackPort['error']>) { this.error = error; this.emit('error') }
  dispose() {
    this.cancelNative()
    this.playIntent++; this.generation++; this.token++; this.lifetime++
    this.anchor.dispose()
    this.worker?.terminate(); this.node?.disconnect(); this.node?.port.close()
    this.worker = undefined; this.node = undefined; this.opening = undefined
    this.tracks = []; this.paused = true; this.source = undefined
  }
}
export const playbackEngine = new PlaybackEngine()
