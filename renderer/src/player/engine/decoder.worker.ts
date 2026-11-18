import { MPEGDecoder } from 'mpg123-decoder'
import { engineError, id3Size, parseMP3, seekByte } from './mp3'
import { range, RANGE_BYTES } from './range'
import { bisectSeek, decoderPage, flacFrame, floorPoint, oggPages, parseFLAC, parseOgg, parseWAV, sniff, trimEnd, wavPCM, type AudioInfo, type Format } from './formats'
import { SincResampler } from './resampler'
import { AACRanges } from './aac'
import { AACStream, type AACCodec } from './aacStream'
import type { AACPacket, AACPCM } from './aacDecoder'

interface Result { channelData: Float32Array[]; samplesDecoded: number; sampleRate: number; errors: { message: string }[] }
interface Decoder { ready: Promise<void>; reset(): Promise<void> | void; decode(data: Uint8Array): Result | Promise<Result>; flush?(): Promise<Result>; decodeFrames?(frames: Uint8Array[]): Result | Promise<Result> }
const scope = self as unknown as { onmessage: (event: MessageEvent) => void; postMessage: (value: unknown, transfer?: Transferable[]) => void }
const mpeg = new MPEGDecoder({ enableGapless: true })
const codecs = new Map<Format, Decoder>()
let controller = new AbortController(), token = 0, tail = Promise.resolve()
interface Job {
  id: number; src: string; offset: number; total: number; bytes: Uint8Array; cursor: number
  info: AudioInfo; first: boolean; format: Format; decoder?: Decoder; resampler: SincResampler
  position: number; target: number; eof: boolean; pending?: Float32Array[]; pendingAt: number; outputRate: number
  alignPage?: boolean
}
let job: Job | undefined
let aac: AACStream | undefined
let aacId = 0, requestId = 0
const requests = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
function bridge(signal: AbortSignal, id: number): AACCodec {
  const call = (operation: string, payload: object = {}) => new Promise<unknown>((resolve, reject) => {
    const request = ++requestId
    const abort = () => { requests.delete(request); reject(new DOMException('Cancelled', 'AbortError')) }
    requests.set(request, { resolve: value => { signal.removeEventListener('abort', abort); resolve(value) }, reject: error => { signal.removeEventListener('abort', abort); reject(error) } })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { abort(); return }
    post({ type: 'aac', id, operation, request, ...payload })
  })
  return {
    supported: async config => await call('supported', { config }) as boolean,
    open: async config => { await call('open', { config }) },
    decode: async (packets: AACPacket[]) => await call('decode', { packets }) as AACPCM[],
    close: () => { if (!signal.aborted) post({ type: 'aac', id, operation: 'close' }) },
  }
}
const post = (data: object, transfer?: Transferable[]) => scope.postMessage({ ...data, token }, transfer)
async function codec(format: Format): Promise<Decoder> {
  if (format === 'mp3') return mpeg
  if (!codecs.has(format)) {
    if (format === 'flac') { const { FLACDecoder } = await import('@wasm-audio-decoders/flac'); codecs.set(format, new FLACDecoder()) }
    if (format === 'opus') { const { OggOpusDecoder } = await import('ogg-opus-decoder'); codecs.set(format, new OggOpusDecoder()) }
    if (format === 'vorbis') { const { OggVorbisDecoder } = await import('@wasm-audio-decoders/ogg-vorbis'); codecs.set(format, new OggVorbisDecoder()) }
  }
  return codecs.get(format)!
}
async function start(m: { id: number; src: string; seconds: number; info?: AudioInfo; outputRate?: number; webCodecs?: boolean }, signal: AbortSignal) {
  // Keep MP3's persistent warm-up and cancellation behavior.
  await mpeg.ready
  if (signal.aborted) return
  const head = await range(m.src, 0, signal, fields => { if (!signal.aborted) post({ type: 'firstByte', id: m.id, ...fields }) })
  if (signal.aborted) return
  let data = head.bytes, base = 0
  const format = sniff(data)
  if (!format) throw Object.assign(new Error('Unknown audio magic'), engineError('notSupported'))
  if (format === 'native' || format === 'aac') {
    const adts = data[0] === 255
    // The main-thread capability flag also lets tests force the legacy fallback.
    if (m.webCodecs !== false) {
      const stream = new AACStream(new AACRanges(m.src, signal, data, head.total), signal, m.outputRate || 44100)
      let opened: boolean
      try { opened = await stream.open(adts, m.seconds, m.webCodecs ? bridge(signal, m.id) : undefined) }
      catch (error) { stream.close(); throw error }
      if (opened) {
        if (signal.aborted) { stream.close(); return }
        aac = stream; aacId = m.id
        post({ type: 'metadata', id: m.id, info: stream.info, rate: stream.outputRate, decoderLocation: stream.location })
        return
      }
      stream.close()
    }
    if (!signal.aborted) post({ type: 'native', id: m.id, adts })
    return
  }
  let info: AudioInfo
  if (format === 'mp3') {
    const tagSize = id3Size(data)
    if (tagSize >= data.length) { base = tagSize; data = (await range(m.src, base, signal)).bytes }
    info = m.info || { ...parseMP3(data, head.total, base), format }
  } else if (format === 'flac') {
    // Metadata can span slices (e.g. a cover picture). It is discarded after parsing.
    while (true) {
      try { info = parseFLAC(data, head.total); break }
      catch (error) {
        if (!String(error).includes('Incomplete') || data.length >= head.total) throw error
        const part = (await range(m.src, data.length, signal)).bytes
        const joined = new Uint8Array(data.length + part.length); joined.set(data); joined.set(part, data.length); data = joined
      }
    }
  } else if (format === 'wav') {
    while (true) {
      try { info = parseWAV(data, head.total); break }
      catch (error) {
        if (!String(error).includes('Incomplete') || data.length >= head.total) throw error
        const part = (await range(m.src, data.length, signal)).bytes
        const joined = new Uint8Array(data.length + part.length); joined.set(data); joined.set(part, data.length); data = joined
      }
    }
  }
  else {
    const tailOffset = Math.max(0, head.total - RANGE_BYTES)
    const end = tailOffset ? (await range(m.src, tailOffset, signal)).bytes : data
    info = parseOgg(data, end, format, head.total)
  }
  const decoder = format === 'wav' ? undefined : await codec(format)
  await decoder?.ready
  if (signal.aborted) return
  await decoder?.reset()
  if (signal.aborted) return
  let offset = base, position = 0
  const target = Math.round(m.seconds * info.sampleRate)
  if (format === 'mp3' && m.seconds > 0) { offset = seekByte(info, m.seconds); data = (await range(m.src, offset, signal)).bytes; position = target }
  if (format === 'wav') { offset = info.audioOffset + Math.min(info.totalSamples!, target) * info.wav!.align; position = Math.min(info.totalSamples!, target); data = offset < head.total ? (await range(m.src, offset, signal)).bytes : new Uint8Array() }
  if (format === 'flac') {
    let point = { byte: info.audioOffset, sample: 0 }
    if (target > 0) point = floorPoint(info.seekTable || [], target) || await bisectSeek(info.audioOffset, head.total, target, async byte => {
      const bytes = (await range(m.src, byte, signal)).bytes, points = []
      for (let at = 0; at < bytes.length - 16; at++) { const frame = flacFrame(bytes, at, info.blockSize!); if (frame) points.push({ byte: byte + at, sample: frame.sample }) }
      return points
    })
    offset = point.byte; position = point.sample; data = (await range(m.src, offset, signal)).bytes
  }
  let alignPage = false
  if ((format === 'opus' || format === 'vorbis') && target > 0) {
    // Re-send identification/setup pages, then jump to a page before the target.
    // A full preceding page supplies Opus preroll and Vorbis overlap history.
    const wanted = Math.max(0, target + info.delay - info.sampleRate)
    const point = await bisectSeek(0, head.total, wanted, async byte => oggPages((await range(m.src, byte, signal)).bytes, byte).filter(p => p.sample >= 0 && !(p.flags & 1)))
    if (point.sample > 0) {
      // Vorbis comments/setup can span multiple pages and multiple fetches.
      let headerOffset = 0, primed = false
      while (!primed && headerOffset < point.byte) {
        const bytes = headerOffset ? (await range(m.src, headerOffset, signal)).bytes : head.bytes
        const pages = oggPages(bytes)
        if (!pages.length) throw new Error('Incomplete Ogg headers')
        for (const page of pages) {
          if (page.sample > 0) { primed = true; break }
          await decoder!.decode(decoderPage(bytes.subarray(page.byte, page.byte + page.length), true))
          headerOffset += page.length
        }
      }
      offset = point.byte
      data = (await range(m.src, offset, signal)).bytes
      alignPage = true
    }
  }
  if (signal.aborted) return
  const outputRate = m.outputRate || info.sampleRate
  job = { id: m.id, src: m.src, offset, total: head.total, bytes: data, cursor: 0, info, first: true, format, decoder, position, target, eof: false, pendingAt: 0, outputRate, alignPage, resampler: new SincResampler(info.sampleRate, outputRate) }
  post({ type: 'metadata', id: m.id, info, rate: outputRate })
}
async function more(j: Job, signal: AbortSignal, preserve = false) {
  const next = j.offset + j.bytes.length
  if (next >= j.total) return false
  const part = (await range(j.src, next, signal)).bytes
  if (preserve) {
    const rest = j.bytes.subarray(j.cursor), joined = new Uint8Array(rest.length + part.length)
    joined.set(rest); joined.set(part, rest.length); j.offset += j.cursor; j.cursor = 0; j.bytes = joined
  } else { j.offset = next; j.bytes = part; j.cursor = 0 }
  return true
}
async function decode(j: Job, signal: AbortSignal): Promise<Float32Array[]> {
  if (j.cursor >= j.bytes.length) await more(j, signal)
  let result: Result
  if (j.format === 'wav') {
    const end = Math.min(j.bytes.length, j.info.wav!.end - j.offset)
    let length = Math.min(16384 * j.info.wav!.align, end - j.cursor)
    length -= length % j.info.wav!.align
    if (!length && j.offset + end < j.info.wav!.end) { await more(j, signal, true); return decode(j, signal) }
    const channels = wavPCM(j.bytes.subarray(j.cursor, j.cursor + length), j.info.wav!)
    j.cursor += length
    result = { channelData: channels, samplesDecoded: channels[0].length, sampleRate: j.info.sampleRate, errors: [] }
    j.eof = j.offset + j.cursor >= j.info.wav!.end
  } else if (j.format === 'flac') {
    let next = j.cursor + 2
    while (true) {
      for (; next < j.bytes.length - 16; next++) if (flacFrame(j.bytes, next, j.info.blockSize!)) break
      if (next < j.bytes.length - 16) break
      const scanned = next - j.cursor
      if (!await more(j, signal, true)) { next = j.bytes.length; break }
      next = Math.max(2, scanned)
    }
    result = await j.decoder!.decodeFrames!([j.bytes.subarray(j.cursor, next)])
    j.cursor = next; j.eof = j.offset + next >= j.total
  } else if (j.format === 'opus' || j.format === 'vorbis') {
    let page = oggPages(j.bytes.subarray(j.cursor))[0]
    while (!page && await more(j, signal, true)) page = oggPages(j.bytes)[0]
    if (!page) throw new Error('Incomplete Ogg page')
    const start = j.cursor + page.byte
    result = await j.decoder!.decode(decoderPage(j.bytes.subarray(start, start + page.length)))
    j.cursor = start + page.length; j.eof = j.offset + j.cursor >= j.total
    if (j.alignPage && result.samplesDecoded) {
      j.position = Math.max(0, page.sample - j.info.delay - result.samplesDecoded); j.alignPage = false
    }
  } else {
    const end = Math.min(j.cursor + 4096, j.bytes.length)
    if (end === j.cursor && j.decoder!.flush) { result = await j.decoder!.flush(); j.eof = true }
    else {
      result = await j.decoder!.decode(j.bytes.subarray(j.cursor, end)); j.cursor = end
      if (j.offset + end >= j.total && !j.decoder!.flush) j.eof = true
    }
  }
  if (result.errors.length) throw new Error(result.errors[0].message)
  let channels = result.channelData
  if (!result.samplesDecoded) channels = Array.from({ length: j.info.wav?.channels || channels.length || 2 }, () => new Float32Array())
  // Opus applies pre-skip in the wrapper; cap its remaining PCM at endGranule
  // minus preSkip. Vorbis uses endGranule, FLAC STREAMINFO, WAV data size.
  if (j.info.totalSamples > 0) channels = trimEnd(channels, j.position, j.info.totalSamples)
  const skip = Math.max(0, Math.min(channels[0]?.length || 0, j.target - j.position))
  j.position += channels[0]?.length || 0
  channels = channels.map(c => c.subarray(skip))
  return j.resampler.process(channels, j.eof)
}
async function pull(signal: AbortSignal) {
  if (aac) {
    const stream = aac, channels = await stream.read()
    if (signal.aborted) return
    post({ type: 'memory', id: aacId, bytes: channels.reduce((sum, c) => sum + c.byteLength, 0) })
    if (channels[0]?.length) post({ type: 'pcm', id: aacId, channels, rate: stream.outputRate }, channels.map(c => c.buffer as ArrayBuffer))
    if (stream.done) {
      post({ type: 'metadata', id: aacId, info: stream.info, rate: stream.outputRate, decoderLocation: stream.location })
      aac = undefined
    }
    post({ type: 'memory', id: aacId, bytes: 0 })
    post({ type: stream.done ? 'done' : 'pulled', id: aacId })
    return
  }
  const j = job
  if (!j) return
  if (!j.pending) {
    j.pending = await decode(j, signal); j.pendingAt = 0
    if (signal.aborted) return
  }
  const frames = Math.min(j.outputRate, (j.pending[0]?.length || 0) - j.pendingAt)
  if (frames) {
    const channels = j.pending.map(c => c.slice(j.pendingAt, j.pendingAt + frames))
    j.pendingAt += frames; j.first = false
    post({ type: 'pcm', id: j.id, channels, rate: j.outputRate }, channels.map(c => c.buffer as ArrayBuffer))
  }
  if (!frames || j.pendingAt >= j.pending[0].length) j.pending = undefined
  const done = j.eof && !j.pending
  // FLAC permits STREAMINFO's sample count to be unknown (zero). Decode bounded
  // frames normally, then publish the measured duration at EOF.
  if (done && j.format === 'flac' && !j.info.totalSamples) {
    j.info.totalSamples = j.position; j.info.duration = j.position / j.info.sampleRate
    post({ type: 'metadata', id: j.id, info: j.info, rate: j.outputRate })
  }
  if (done && j.first && j.target < (j.info.totalSamples ?? Infinity)) throw new Error('No decoded audio frames')
  post({ type: 'memory', id: j.id, bytes: j.pending?.reduce((sum, c) => sum + c.byteLength, 0) || 0 })
  post({ type: done ? 'done' : 'pulled', id: j.id })
  if (done) job = undefined
}
scope.onmessage = ({ data: m }) => {
  if (m.type === 'aacResult') { const pending = requests.get(m.request); requests.delete(m.request); if (m.error) pending?.reject(new Error(m.error)); else pending?.resolve(m.value); return }
  if (m.type === 'start' || m.type === 'cancel') { aac?.close(); aac = undefined; controller.abort(); controller = new AbortController(); token = m.token; job = undefined }
  const signal = controller.signal, own = token
  tail = tail.then(async () => {
    if (signal.aborted || own !== token) return
    try {
      if (m.type === 'start') await start(m, signal)
      if (m.type === 'pull') await pull(signal)
    } catch (error) {
      if (!signal.aborted) { aac?.close(); aac = undefined; post({ type: 'error', id: m.id, error: { ...engineError('decode'), ...(error as object), message: String(error) } }) }
    }
  })
}
