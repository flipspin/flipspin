import type { MP3Info } from './mp3'

export type Format = 'mp3' | 'flac' | 'opus' | 'vorbis' | 'wav' | 'aac' | 'native'
export interface SeekPoint { byte: number; sample: number }
export interface AudioInfo extends MP3Info {
  adts?: boolean
  format?: Format
  totalSamples?: number
  seekTable?: SeekPoint[]
  blockSize?: number
  wav?: { channels: number; bits: number; float: boolean; align: number; end: number }
}
export const ascii = (data: Uint8Array, start: number, size: number) => String.fromCharCode(...data.subarray(start, start + size))
export const viewOf = (data: Uint8Array) => new DataView(data.buffer, data.byteOffset, data.byteLength)
export function sniff(data: Uint8Array): Format | undefined {
  if (ascii(data, 0, 4) === 'fLaC') return 'flac'
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WAVE') return 'wav'
  if (ascii(data, 4, 4) === 'ftyp') return 'native'
  if (ascii(data, 0, 4) === 'OggS' && data.length > 27 + data[26]) {
    const start = 27 + data[26]
    if (ascii(data, start, 8) === 'OpusHead') return 'opus'
    if (data[start] === 1 && ascii(data, start + 1, 6) === 'vorbis') return 'vorbis'
    return undefined
  }
  if (ascii(data, 0, 3) === 'ID3') return 'mp3'
  if (data[0] === 255 && (data[1] & 0xf6) === 0xf0) return 'native' // ADTS, layer 00
  if (data[0] === 255 && (data[1] & 0xe6) === 0xe2) return 'mp3' // Layer III
}
export function audioInfo(format: Format, sampleRate: number, totalSamples: number, bytes: number, audioOffset = 0): AudioInfo {
  return { format, sampleRate, totalSamples, duration: totalSamples / sampleRate, bytes, audioOffset, bitrate: 0, delay: 0, padding: 0 }
}
export function parseFLAC(data: Uint8Array, total: number): AudioInfo {
  const view = viewOf(data), table: SeekPoint[] = []
  let at = 4, info: AudioInfo | undefined
  while (at + 4 <= data.length) {
    const last = !!(data[at] & 128), type = data[at] & 127
    const size = (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3], start = at + 4
    if (start + size > data.length) throw new Error('Incomplete FLAC metadata')
    if (type === 0 && size === 34) {
      const rate = view.getUint32(start + 10) >>> 12
      const samples = (data[start + 13] & 15) * 4294967296 + view.getUint32(start + 14)
      info = audioInfo('flac', rate, samples, total)
      info.blockSize = view.getUint16(start + 2)
    }
    if (type === 3) for (let p = start; p + 18 <= start + size; p += 18) {
      const sample = Number(view.getBigUint64(p)), byte = Number(view.getBigUint64(p + 8))
      if (Number.isSafeInteger(sample) && Number.isSafeInteger(byte)) table.push({ sample, byte })
    }
    at = start + size
    if (last) {
      if (!info?.sampleRate) throw new Error('Missing FLAC STREAMINFO')
      info.audioOffset = at; info.seekTable = table.map(p => ({ ...p, byte: p.byte + at }))
      return info
    }
  }
  throw new Error('Incomplete FLAC metadata')
}
/** CRC-8 rejects sync-like bytes inside compressed frame payloads. */
export function flacFrame(data: Uint8Array, at: number, fixedBlock: number): (SeekPoint & { size: number }) | undefined {
  if (data[at] !== 255 || (data[at + 1] & 254) !== 248 || (data[at + 3] & 1)) return
  const code = data[at + 2] >>> 4, rate = data[at + 2] & 15
  if (!code || rate === 15 || (data[at + 3] >>> 4) > 10) return
  let p = at + 4, number = data[p++], continuation = 0
  if (number >= 128) {
    let mask = 128
    while (number & mask) { continuation++; mask >>>= 1 }
    if (continuation < 2 || continuation > 7) return
    number &= mask - 1
    for (let i = 1; i < continuation; i++) {
      if ((data[p] & 192) !== 128) return
      number = number * 64 + (data[p++] & 63)
    }
  }
  let size = code === 1 ? 192 : code <= 5 ? 576 * 2 ** (code - 2) : code >= 8 ? 256 * 2 ** (code - 8) : 0
  if (code === 6) size = data[p++] + 1
  if (code === 7) { size = (data[p] << 8 | data[p + 1]) + 1; p += 2 }
  if (rate === 12) p++
  if (rate === 13 || rate === 14) p += 2
  if (p >= data.length) return
  let crc = 0
  for (let i = at; i < p; i++) {
    crc ^= data[i]
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1 ^ (crc & 128 ? 7 : 0)) & 255
  }
  if (crc !== data[p]) return
  return { byte: at, sample: data[at + 1] & 1 ? number : number * fixedBlock, size }
}
export interface OggPage extends SeekPoint { length: number; flags: number; serial: number }
/** Ogg's non-reflected CRC, including the header with its checksum zeroed. */
export function oggChecksum(page: Uint8Array) {
  const result = page.slice(); result.fill(0, 22, 26)
  let crc = 0
  for (const byte of result) {
    crc ^= byte << 24
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)
  }
  viewOf(result).setUint32(22, crc >>> 0, true)
  return result
}
/** The worker owns end trimming. Disabling wrapper EOS trimming also makes
 * midstream seeks independent of each wrapper's relative sample counter. */
export function decoderPage(page: Uint8Array, seeking = false) {
  const copy = page.slice(); copy[5] &= ~4
  const start = 27 + copy[26]
  if (seeking && ascii(copy, start, 8) === 'OpusHead') viewOf(copy).setUint16(start + 10, 0, true)
  const checked = oggChecksum(copy), withLookahead = new Uint8Array(checked.length + 1)
  // codec-parser requires one byte of lookahead; an invalid sync byte is safely
  // skipped before the next page. This keeps decode results page-aligned.
  withLookahead.set(checked)
  return withLookahead
}
export function oggPages(data: Uint8Array, base = 0): OggPage[] {
  const result: OggPage[] = [], view = viewOf(data)
  for (let at = 0; at + 27 <= data.length; at++) {
    if (ascii(data, at, 4) !== 'OggS' || data[at + 4] !== 0) continue
    const count = data[at + 26]
    if (at + 27 + count > data.length) break
    let length = 27 + count
    for (let i = 0; i < count; i++) length += data[at + 27 + i]
    if (at + length > data.length) break
    result.push({ byte: base + at, sample: Number(view.getBigInt64(at + 6, true)), length, flags: data[at + 5], serial: view.getUint32(at + 14, true) })
    at += length - 1
  }
  return result
}
export function parseOgg(head: Uint8Array, tail: Uint8Array, format: 'opus' | 'vorbis', total: number): AudioInfo {
  const start = 27 + head[26], view = viewOf(head)
  const rate = format === 'opus' ? 48000 : view.getUint32(start + 12, true)
  const delay = format === 'opus' ? view.getUint16(start + 10, true) : 0
  const serial = view.getUint32(14, true)
  const end = oggPages(tail).filter(p => p.serial === serial && p.flags & 4).at(-1)
  if (!end || !rate) throw new Error('Missing Ogg end granule')
  return { ...audioInfo(format, rate, Math.max(0, end.sample - delay), total), delay }
}
export function parseWAV(data: Uint8Array, total: number): AudioInfo {
  const view = viewOf(data)
  let wav: AudioInfo['wav'], rate = 0
  for (let at = 12; at + 8 <= data.length;) {
    const tag = ascii(data, at, 4), size = view.getUint32(at + 4, true), start = at + 8
    if (tag === 'fmt ' && size >= 16 && start + size <= data.length) {
      let kind = view.getUint16(start, true)
      if (kind === 0xfffe && size >= 40) kind = view.getUint16(start + 24, true)
      const bits = view.getUint16(start + 14, true), channels = view.getUint16(start + 2, true), align = view.getUint16(start + 12, true)
      rate = view.getUint32(start + 4, true)
      if (!rate || channels < 1 || channels > 8 || !((kind === 1 && [16,24,32].includes(bits)) || (kind === 3 && bits === 32)) || align !== channels * bits / 8) throw new Error('Unsupported WAV encoding')
      wav = { channels, bits, float: kind === 3, align, end: 0 }
    }
    if (tag === 'data' && wav) {
      wav.end = Math.min(total, start + size)
      return { ...audioInfo('wav', rate, Math.floor((wav.end - start) / wav.align), total, start), wav }
    }
    at = start + size + (size & 1)
  }
  throw new Error('Incomplete WAV header')
}
export function wavPCM(data: Uint8Array, wav: NonNullable<AudioInfo['wav']>): Float32Array[] {
  const view = viewOf(data), frames = Math.floor(data.length / wav.align)
  return Array.from({ length: wav.channels }, (_, channel) => Float32Array.from({ length: frames }, (_, frame) => {
    const at = frame * wav.align + channel * wav.bits / 8
    if (wav.float) return view.getFloat32(at, true)
    if (wav.bits === 16) return view.getInt16(at, true) / 32768
    if (wav.bits === 32) return view.getInt32(at, true) / 2147483648
    const value = data[at] | data[at + 1] << 8 | data[at + 2] << 16
    return (value << 8 >> 8) / 8388608
  }))
}
export function floorPoint(points: SeekPoint[], sample: number): SeekPoint | undefined {
  return points.filter(p => p.sample <= sample).reduce<SeekPoint | undefined>((best, p) => !best || p.sample > best.sample ? p : best, undefined)
}
/** Fetch bounded probes and converge on the last frame/page before the target. */
export async function bisectSeek(start: number, end: number, sample: number, probe: (byte: number) => Promise<SeekPoint[]>): Promise<SeekPoint> {
  let low = start, high = end, best = { byte: start, sample: 0 }
  while (low < high) {
    const mid = Math.floor((low + high) / 2), points = await probe(mid)
    const before = floorPoint(points, sample)
    if (before) { if (before.sample >= best.sample) best = before; low = Math.max(mid + 1, before.byte + 1) }
    else high = mid
  }
  return best
}
/** Cap already primed PCM against the absolute source timeline (never trim twice). */
export function trimEnd(channels: Float32Array[], position: number, end: number) {
  return channels.map(c => c.subarray(0, Math.max(0, Math.min(c.length, end - position))))
}
