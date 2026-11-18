import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AACRanges, aacSeek, aacTrim, adtsHeader, boxes, parseMP4, parseSMPB } from './aac'
import { AACDecoder } from './aacDecoder'
import { AACStream } from './aacStream'
import { TrackRing } from './ringBuffer'
const fixture = () => new Uint8Array(readFileSync(resolve(import.meta.dirname, 'fixtures/tone.m4a')))
afterEach(() => vi.unstubAllGlobals())
function box(type: string, ...parts: Uint8Array[]) {
  const data = new Uint8Array(8 + parts.reduce((n, p) => n + p.length, 0)); new DataView(data.buffer).setUint32(0, data.length)
  data.set(new TextEncoder().encode(type), 4); let at = 8
  for (const part of parts) { data.set(part, at); at += part.length }
  return data
}
const text = (value: string) => new TextEncoder().encode(value)
it('reads the real fixture sample table, ASC, media scale and edit list', () => {
  const data = fixture(), track = parseMP4(data)!
  expect(track.config).toMatchObject({ codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2 })
  expect(Array.from(track.config.description as Uint8Array).slice(0, 2)).toEqual([18, 16])
  expect(track.samples).toHaveLength(6)
  expect(track.samples.map(s => s.start)).toEqual([0, 1024, 2048, 3072, 4096, 5120])
  expect(track.edit).toEqual({ mediaTime: 1024, duration: 4410 })
  expect(track).toMatchObject({ delay: 1024, frames: 4410, padding: 0 })
  for (const sample of track.samples) expect(data.slice(sample.byte, sample.byte + sample.size).length).toBe(sample.size)
  expect(track.samples.reduce((n, s) => n + s.size, 0)).toBe(boxes(data).find(b => b.type === 'mdat')!.end - boxes(data).find(b => b.type === 'mdat')!.body)
})
it('reads freeform iTunSMPB while edit list remains authoritative', () => {
  const data = fixture(), moov = boxes(data).find(b => b.type === 'moov')!
  const smpb = ' 00000000 00000840 00000100 0000000000001000'
  const item = box('----', box('name', new Uint8Array(4), text('iTunSMPB')), box('data', new Uint8Array(8), text(smpb)))
  const extended = box('moov', data.slice(moov.body, moov.end), box('udta', box('meta', new Uint8Array(4), box('ilst', item))))
  // Remove ffmpeg's original udta so there is one metadata container.
  const children = boxes(extended, 8).filter(b => b.type !== 'udta')
  const merged = box('moov', ...children.map(b => extended.slice(b.start, b.end)), box('udta', box('meta', new Uint8Array(4), box('ilst', item))))
  const track = parseMP4(merged)!
  expect(track.smpb).toEqual({ delay: 2112, padding: 256, length: 4096 })
  expect(track.frames).toBe(4410)
  expect(parseSMPB('broken')).toBeUndefined()
})
it('prioritizes edit duration, then SMPB length/padding, then the container-only AAC default', () => {
  expect(aacTrim(8192, { mediaTime: 1024, duration: 4410 }, { delay: 2112, padding: 256, length: 4096 })).toEqual({ delay: 1024, frames: 4410, padding: 2758 })
  expect(aacTrim(8192, undefined, { delay: 2112, padding: 256, length: 5824 })).toEqual({ delay: 2112, frames: 5824, padding: 256 })
  expect(aacTrim(8192)).toEqual({ delay: 2112, frames: 6080, padding: 0 })
  expect(aacTrim(512)).toEqual({ delay: 512, frames: 0, padding: 0 })
})
it('chooses exactly one frame of seek preroll, including exact frame edges', () => {
  const samples = parseMP4(fixture())!.samples
  expect(aacSeek(samples, 0)).toBe(0)
  expect(aacSeek(samples, 3072)).toBe(2)
  expect(aacSeek(samples, 3300)).toBe(2)
})
it('parses 7/9-byte ADTS headers and rejects malformed, reserved and multi-block frames', () => {
  const header = new Uint8Array([255, 241, 80, 128, 12, 159, 252])
  expect(adtsHeader(header)).toMatchObject({ size: 100, header: 7, frames: 1024, config: { sampleRate: 44100, numberOfChannels: 2, description: new Uint8Array([18, 16]) } })
  header[1] = 240; expect(adtsHeader(header).header).toBe(9)
  header[6] |= 1; expect(() => adtsHeader(header)).toThrow('Unsupported')
  header[2] = 124; expect(() => adtsHeader(header)).toThrow()
  expect(() => adtsHeader(new Uint8Array(6))).toThrow('Invalid')
})
it('rejects fragmented, ALAC and unavailable/unsupported WebCodecs into native fallback', async () => {
  const data = fixture(), moov = boxes(data).find(b => b.type === 'moov')!
  expect(parseMP4(box('moov', data.slice(moov.body, moov.end), box('mvex')))).toBeUndefined()
  const alac = data.slice(), entry = Buffer.from(alac).indexOf('mp4a'); alac.set(text('alac'), entry)
  expect(parseMP4(alac)).toBeUndefined()
  vi.stubGlobal('AudioDecoder', undefined)
  const config = parseMP4(data)!.config
  expect(await AACDecoder.supported(config)).toBe(false)
  vi.stubGlobal('AudioDecoder', { isConfigSupported: async () => ({ supported: false }) })
  expect(await AACDecoder.supported(config)).toBe(false)
  const stream = new AACStream(new AACRanges('fixture', new AbortController().signal, data, data.length), new AbortController().signal, 44100)
  expect(await stream.open(false, 0)).toBe(false)
})
it('fetches tail moov before sample payloads in requests no larger than 256 KiB', async () => {
  const source = fixture(), top = boxes(source), moov = top.find(b => b.type === 'moov')!
  const prefix = box('free', new Uint8Array(600000)), data = new Uint8Array(prefix.length + source.length)
  data.set(prefix); data.set(source, prefix.length)
  const requests: number[] = []
  vi.stubGlobal('fetch', vi.fn(async (_src, init) => {
    const [, first, last] = /bytes=(\d+)-(\d+)/.exec((init.headers as Record<string, string>).Range)!
    const start = +first, end = Math.min(+last, data.length - 1); requests.push(start)
    expect(+last - start + 1).toBeLessThanOrEqual(262144)
    return new Response(data.slice(start, end + 1), { status: 206, headers: { 'Content-Range': `bytes ${start}-${end}/${data.length}` } })
  }))
  const ranges = new AACRanges('fixture', new AbortController().signal, data.slice(0, 262144), data.length)
  const track = await ranges.mp4()
  expect(track!.frames).toBe(4410)
  expect(requests).toContain(data.length - 262144)
  expect(moov.start).toBeGreaterThan(0)
})
it.each([[false, false], [true, false], [false, true], [true, true]])('fades only ADTS boundaries: outgoing=%s incoming=%s', (a, b) => {
  const ring = new TrackRing(), frames = 300, rate = 44100
  for (const [id, adts] of [[1, a], [2, b]] as const) {
    ring.add(id, rate); ring.format(id, adts); ring.push(id, { rate, channels: [new Float32Array(frames).fill(1)] }); ring.finish(id)
  }
  const output = [new Float32Array(frames * 2)]
  ring.render(output, rate, () => {})
  expect(output[0][0]).toBe(1) // initial start is not a boundary
  expect(output[0][599]).toBe(1) // standalone end is not a boundary
  if (a || b) {
    expect(output[0][299]).toBe(0); expect(output[0][300]).toBe(0)
    expect(output[0][234]).toBeCloseTo(Math.SQRT1_2, 2)
    expect(output[0][366]).toBeCloseTo(Math.SQRT1_2, 2)
  } else expect(output[0].every(v => v === 1)).toBe(true)
})
function replace(data: Uint8Array, path: string[], transform: (box: Uint8Array) => Uint8Array): Uint8Array {
  const parts = boxes(data).map(b => {
    const value = data.slice(b.start, b.end)
    if (b.type !== path[0]) return value
    if (path.length === 1) return transform(value)
    return box(b.type, replace(data.slice(b.body, b.end), path.slice(1), transform))
  })
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0
  for (const p of parts) { result.set(p, at); at += p.length }
  return result
}
it('supports co64 offsets and version-one edit-list fields', () => {
  const original = fixture(), path = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stco']
  let data = replace(original, path, old => {
    const view = new DataView(old.buffer), count = view.getUint32(12), body = new Uint8Array(8 + count * 8), out = new DataView(body.buffer)
    out.setUint32(4, count)
    for (let i = 0; i < count; i++) out.setBigUint64(8 + i * 8, BigInt(view.getUint32(16 + i * 4)))
    return box('co64', body)
  })
  data = replace(data, ['moov', 'trak', 'edts', 'elst'], old => {
    const view = new DataView(old.buffer), body = new Uint8Array(28), out = new DataView(body.buffer)
    body[0] = 1; out.setUint32(4, 1); out.setBigUint64(8, BigInt(view.getUint32(16))); out.setBigInt64(16, BigInt(view.getInt32(20))); out.setUint32(24, 0x10000)
    return box('elst', body)
  })
  expect(parseMP4(data)).toEqual(parseMP4(original))
})
it('rejects planted corrupt sample-table sizes and zero-size child boxes', () => {
  const corrupt = replace(fixture(), ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stts'], old => {
    new DataView(old.buffer).setUint32(12, 0xffffffff); return old
  })
  expect(() => parseMP4(corrupt)).toThrow('Invalid MP4 table length')
  const invalid = new Uint8Array(8); new DataView(invalid.buffer).setUint32(0, 4)
  expect(() => boxes(invalid)).toThrow('Invalid MP4 box size')
})
it('falls back for oversized moov metadata without fetching or allocating its body', async () => {
  const header = new Uint8Array(16), total = 17 * 1024 * 1024
  new DataView(header.buffer).setUint32(0, total); header.set(text('moov'), 4)
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  const ranges = new AACRanges('large-metadata', new AbortController().signal, header, total)
  expect(await ranges.mp4()).toBeUndefined(); expect(fetcher).not.toHaveBeenCalled()
})
