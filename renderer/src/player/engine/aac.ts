import { ascii, viewOf } from './formats'
import { range, RANGE_BYTES } from './range'

export interface Box { type: string; start: number; body: number; end: number }
/** Sizes are checked before walking children; extended sizes must fit JS offsets. */
export function boxAt(data: Uint8Array, at: number, limit = data.length): Box {
  const view = viewOf(data)
  if (at + 8 > data.length) throw new Error('Incomplete MP4 box')
  let size = view.getUint32(at), header = 8
  if (size === 1) { if (at + 16 > data.length) throw new Error('Incomplete MP4 box'); size = Number(view.getBigUint64(at + 8)); header = 16 }
  if (!size) size = limit - at
  if (!Number.isSafeInteger(size) || size < header || at + size > limit) throw new Error('Invalid MP4 box size')
  return { type: ascii(data, at + 4, 4), start: at, body: at + header, end: at + size }
}
export function boxes(data: Uint8Array, start = 0, end = data.length): Box[] {
  const result: Box[] = []
  for (let at = start; at < end;) { const box = boxAt(data, at, end); result.push(box); at = box.end }
  return result
}
const child = (data: Uint8Array, box: Box, type: string) => boxes(data, box.body, box.end).find(b => b.type === type)
const required = (box: Box | undefined): Box => { if (!box) throw new Error('Missing MP4 table'); return box }
export interface AACSample { byte: number; size: number; start: number; duration: number }
export interface AACTrack {
  config: AudioDecoderConfig; samples: AACSample[]; frames: number; delay: number; padding: number
  edit?: { mediaTime: number; duration: number }; smpb?: { delay: number; padding: number; length: number }
}
export function parseSMPB(value: string) {
  const fields = value.trim().split(/\s+/)
  if (fields.length < 4 || !fields.slice(0, 4).every(x => /^[\da-f]{8,16}$/i.test(x))) return undefined
  const [delay, padding, length] = fields.slice(1, 4).map(x => Number.parseInt(x, 16))
  if (![delay, padding, length].every(Number.isSafeInteger)) return undefined
  return { delay, padding, length }
}
/** Metadata is in source PCM frames, regardless of movie/media timescales. */
export function aacTrim(total: number, edit?: { mediaTime: number; duration: number }, smpb?: AACTrack['smpb']) {
  const delay = Math.min(total, Math.max(0, edit?.mediaTime ?? smpb?.delay ?? 2112))
  const frames = Math.max(0, Math.min(total - delay, edit?.duration ?? (smpb ? smpb.length || total - delay - smpb.padding : total - delay)))
  return { delay, frames, padding: total - delay - frames }
}
function specificConfig(data: Uint8Array, start: number, end: number): Uint8Array | undefined {
  for (let at = start; at < end;) {
    const tag = data[at++]; let size = 0, count = 0, next: number
    do { if (at >= end || count++ === 4) throw new Error('Invalid ES descriptor'); next = data[at++]; size = size * 128 + (next & 127) } while (next & 128)
    const stop = at + size
    if (stop > end) throw new Error('Incomplete ES descriptor')
    if (tag === 5) return data.slice(at, stop)
    let nested = at
    if (tag === 3) {
      const flags = data[at + 2]; nested += 3
      if (flags & 128) nested += 2
      if (flags & 64) nested += 1 + data[nested]
      if (flags & 32) nested += 2
    } else if (tag === 4) nested += 13
    else { at = stop; continue }
    const found = specificConfig(data, nested, stop)
    if (found) return found
    at = stop
  }
}
export function parseMP4(data: Uint8Array): AACTrack | undefined {
  const moov = boxes(data).find(b => b.type === 'moov')
  if (!moov || child(data, moov, 'mvex')) return undefined
  const view = viewOf(data), mvhd = required(child(data, moov, 'mvhd'))
  const movieScale = view.getUint32(mvhd.body + (data[mvhd.body] === 1 ? 20 : 12))
  for (const trak of boxes(data, moov.body, moov.end).filter(b => b.type === 'trak')) {
    const mdia = required(child(data, trak, 'mdia')), hdlr = required(child(data, mdia, 'hdlr'))
    if (ascii(data, hdlr.body + 8, 4) !== 'soun') continue
    const mdhd = required(child(data, mdia, 'mdhd')), scale = view.getUint32(mdhd.body + (data[mdhd.body] === 1 ? 20 : 12))
    const minf = required(child(data, mdia, 'minf')), stbl = required(child(data, minf, 'stbl'))
    const stsd = required(child(data, stbl, 'stsd')), entries = boxes(data, stsd.body + 8, stsd.end)
    if (entries.length !== 1 || entries[0].type !== 'mp4a') return undefined // ALAC/encrypted/changing descriptions
    const entry = entries[0], version = view.getUint16(entry.body + 8)
    if (version > 1) return undefined
    const channels = view.getUint16(entry.body + 16), rate = view.getUint32(entry.body + 24) / 65536
    const esds = required(boxes(data, entry.body + (version ? 44 : 28), entry.end).find(b => b.type === 'esds'))
    const description = specificConfig(data, esds.body + 4, esds.end)
    if (!description?.length || !rate || !channels || channels > 8 || !scale || !movieScale) return undefined
    const objectType = description[0] >>> 3
    // This minimal table path supports AAC-LC. Other AAC profiles retain native decoding.
    if (objectType !== 2) return undefined
    const config: AudioDecoderConfig = { codec: `mp4a.40.${objectType}`, sampleRate: rate, numberOfChannels: channels, description: description as Uint8Array<ArrayBuffer> }
    const stsz = required(child(data, stbl, 'stsz')), fixed = view.getUint32(stsz.body + 4), count = view.getUint32(stsz.body + 8)
    if (count > 10_000_000 || (!fixed && stsz.body + 12 + count * 4 > stsz.end)) throw new Error('Invalid MP4 sample sizes')
    const samples: AACSample[] = Array.from({ length: count }, (_, i) => ({ byte: 0, size: fixed || view.getUint32(stsz.body + 12 + i * 4), start: 0, duration: 0 }))
    const stts = required(child(data, stbl, 'stts')); let index = 0, time = 0
    const rows = (box: Box, stride: number) => {
      const n = view.getUint32(box.body + 4)
      if (box.body + 8 + n * stride > box.end) throw new Error('Invalid MP4 table length')
      return Array.from({ length: n }, (_, i) => box.body + 8 + i * stride)
    }
    for (const at of rows(stts, 8)) {
      const n = view.getUint32(at), delta = view.getUint32(at + 4)
      if (!delta || index + n > count) throw new Error('Invalid MP4 timing')
      for (let i = 0; i < n; i++) { const s = samples[index++]; s.start = Math.round(time * rate / scale); time += delta; s.duration = Math.round(time * rate / scale) - s.start }
    }
    if (index !== count) throw new Error('Incomplete MP4 timing')
    const stsc = required(child(data, stbl, 'stsc')), mappings = rows(stsc, 12)
    const stco = required(child(data, stbl, 'stco') || child(data, stbl, 'co64')), chunks = rows(stco, stco.type === 'co64' ? 8 : 4)
    index = 0; let mapping = 0
    for (const [i, at] of chunks.entries()) {
      while (mapping + 1 < mappings.length && view.getUint32(mappings[mapping + 1]) <= i + 1) mapping++
      const m = mappings[mapping]
      if (m === undefined || view.getUint32(m) > i + 1 || view.getUint32(m + 8) !== 1) throw new Error('Invalid MP4 chunk mapping')
      let byte = stco.type === 'co64' ? Number(view.getBigUint64(at)) : view.getUint32(at)
      const n = view.getUint32(m + 4)
      if (!Number.isSafeInteger(byte) || !n || index + n > count) throw new Error('Invalid MP4 chunk offset')
      for (let j = 0; j < n; j++) { const s = samples[index++]; s.byte = byte; byte += s.size }
    }
    if (index !== count) throw new Error('Incomplete MP4 chunks')
    let edit: AACTrack['edit'], smpb: AACTrack['smpb']
    const edts = child(data, trak, 'edts'), elst = edts && child(data, edts, 'elst')
    if (elst) {
      const version = data[elst.body], stride = version === 1 ? 20 : 12
      for (const at of rows(elst, stride)) {
        const duration = version === 1 ? Number(view.getBigUint64(at)) : view.getUint32(at)
        const mediaTime = version === 1 ? Number(view.getBigInt64(at + 8)) : view.getInt32(at + 4)
        if (mediaTime < 0) continue // empty lead edit carries no encoded priming
        if (edit || view.getUint32(at + stride - 4) !== 0x10000) return undefined
        edit = { mediaTime: Math.round(mediaTime * rate / scale), duration: Math.round(duration * rate / movieScale) }
      }
    }
    const udta = child(data, moov, 'udta'), meta = udta && child(data, udta, 'meta')
    const ilst = meta && boxes(data, meta.body + 4, meta.end).find(b => b.type === 'ilst')
    if (ilst) for (const item of boxes(data, ilst.body, ilst.end)) {
      if (item.type !== '----') continue
      const name = child(data, item, 'name'), value = child(data, item, 'data')
      if (name && value && ascii(data, name.body + 4, name.end - name.body - 4) === 'iTunSMPB') smpb = parseSMPB(ascii(data, value.body + 8, value.end - value.body - 8))
    }
    return { config, samples, edit, smpb, ...aacTrim(Math.round(time * rate / scale), edit, smpb) }
  }
}
/** Range cache holds one encoded slice, never an entire mdat. */
export class AACRanges {
  private offset = 0
  constructor(private src: string, private signal: AbortSignal, private bytes: Uint8Array, readonly total: number) {}
  async read(at: number, size: number): Promise<Uint8Array> {
    if (at < 0 || size < 0 || at + size > this.total || size > 16 * 1024 * 1024) throw new Error('Invalid AAC byte range')
    if (at >= this.offset && at + size <= this.offset + this.bytes.length) return this.bytes.subarray(at - this.offset, at - this.offset + size)
    const result = new Uint8Array(size); let copied = 0
    while (copied < size) {
      if (at + copied < this.offset || at + copied >= this.offset + this.bytes.length) { this.offset = at + copied; this.bytes = (await range(this.src, this.offset, this.signal)).bytes }
      const part = this.bytes.subarray(at + copied - this.offset, Math.min(this.bytes.length, at + size - this.offset))
      if (!part.length) throw new Error('Empty AAC range')
      result.set(part, copied); copied += part.length
    }
    return result
  }
  async mp4(): Promise<AACTrack | undefined> {
    let moov: Uint8Array | undefined, tailed = false
    for (let at = 0; at + 8 <= this.total;) {
      const header = await this.read(at, Math.min(16, this.total - at))
      const box = boxAt(header, 0, this.total - at)
      if (box.type === 'moof') return undefined
      if (box.type === 'mdat' && !moov && !tailed) { tailed = true; await this.read(Math.max(0, this.total - RANGE_BYTES), Math.min(RANGE_BYTES, this.total)) }
      if (box.type === 'moov') {
        // Large artwork/metadata keeps the existing native path, including ALAC.
        if (box.end > 16 * 1024 * 1024) return undefined
        moov = (await this.read(at, box.end)).slice()
      }
      at += box.end
    }
    return moov ? parseMP4(moov) : undefined
  }
}
export const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
export function adtsHeader(data: Uint8Array) {
  if (data.length < 7 || data[0] !== 255 || (data[1] & 0xf6) !== 0xf0) throw new Error('Invalid ADTS header')
  const frequency = data[2] >>> 2 & 15, objectType = (data[2] >>> 6) + 1, channels = (data[2] & 1) << 2 | data[3] >>> 6
  const size = (data[3] & 3) << 11 | data[4] << 3 | data[5] >>> 5, header = data[1] & 1 ? 7 : 9
  if (!ADTS_RATES[frequency] || !channels || size <= header || (data[6] & 3) || objectType !== 2) throw new Error('Unsupported ADTS header')
  return { size, header, frames: 1024, config: { codec: `mp4a.40.${objectType}`, sampleRate: ADTS_RATES[frequency], numberOfChannels: channels, description: new Uint8Array([objectType << 3 | frequency >>> 1, (frequency & 1) << 7 | channels << 3]) } satisfies AudioDecoderConfig }
}
export function aacSeek(samples: AACSample[], target: number) {
  let low = 0, high = samples.length
  while (low < high) { const mid = (low + high) >>> 1; if (samples[mid].start <= target) low = mid + 1; else high = mid }
  return Math.max(0, low - 2) // one complete AAC frame before the target frame
}
