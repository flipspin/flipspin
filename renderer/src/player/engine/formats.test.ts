import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FLACDecoder } from '@wasm-audio-decoders/flac'
import { OggOpusDecoder } from 'ogg-opus-decoder'
import { OggVorbisDecoder } from '@wasm-audio-decoders/ogg-vorbis'
import { bisectSeek, decoderPage, flacFrame, floorPoint, oggPages, parseFLAC, parseOgg, parseWAV, sniff, trimEnd, wavPCM } from './formats'
import { SincResampler } from './resampler'
const bytes = (text: string) => new TextEncoder().encode(text)
const fixture = (name: string) => new Uint8Array(readFileSync(resolve(import.meta.dirname, `fixtures/tone.${name}`)))

describe('magic dispatch and exact format timelines', () => {
  it('sniffs all accepted containers independently of filenames and rejects unknown Ogg codecs', () => {
    expect(sniff(bytes('ID3\0\0\0'))).toBe('mp3')
    expect(sniff(new Uint8Array([255,251,224,0]))).toBe('mp3')
    expect(sniff(new Uint8Array([255,241,80,128]))).toBe('native')
    expect(sniff(bytes('\0\0\0\x18ftypM4A '))).toBe('native')
    expect(sniff(bytes('RIFF\0\0\0\0WAVE'))).toBe('wav')
    expect(sniff(fixture('flac'))).toBe('flac')
    expect(sniff(fixture('opus'))).toBe('opus')
    expect(sniff(fixture('ogg'))).toBe('vorbis')
    expect(sniff(bytes('OggS unknown codec'))).toBeUndefined()
    expect(sniff(bytes('unrecognized'))).toBeUndefined()
  })
  it('applies Opus pre-skip and EOS granule once through the streaming decoder', async () => {
    const data = fixture('opus'), info = parseOgg(data, data, 'opus', data.length)
    expect(info.delay).toBe(312); expect(info.totalSamples).toBe(4800)
    const decoder = new OggOpusDecoder(); await decoder.ready
    const chunks = []
    try {
      for (const page of oggPages(data)) chunks.push(await decoder.decode(decoderPage(data.subarray(page.byte, page.byte + page.length))))
      let position = 0
      for (const chunk of chunks) position += trimEnd(chunk.channelData, position, info.totalSamples!)[0]?.length || 0
      expect(position).toBe(4800)
    } finally { decoder.free() }
  })
  it('trims Vorbis to the end granule and FLAC to STREAMINFO', async () => {
    const ogg = fixture('ogg'), flac = fixture('flac')
    const vorbisInfo = parseOgg(ogg, ogg, 'vorbis', ogg.length), flacInfo = parseFLAC(flac, flac.length)
    expect(vorbisInfo.totalSamples).toBe(4416); expect(flacInfo.totalSamples).toBe(4410)
    const vorbis = new OggVorbisDecoder(), lossless = new FLACDecoder()
    await Promise.all([vorbis.ready, lossless.ready])
    try {
      expect((await vorbis.decodeFile(ogg)).samplesDecoded).toBe(4416)
      expect((await lossless.decodeFile(flac)).samplesDecoded).toBe(4410)
      expect(trimEnd([new Float32Array(1024)], 4096, 4410)[0]).toHaveLength(314)
      expect(trimEnd([new Float32Array(1024)], 4410, 4410)[0]).toHaveLength(0)
    } finally { vorbis.free(); lossless.free() }
  })
})
function wav(bits: number, float = false) {
  const data = new Uint8Array(44 + bits / 8 * 3), view = new DataView(data.buffer)
  data.set(bytes('RIFF')); data.set(bytes('WAVEfmt '), 8); view.setUint32(16, 16, true)
  view.setUint16(20, float ? 3 : 1, true); view.setUint16(22, 1, true); view.setUint32(24, 44100, true)
  view.setUint16(32, bits / 8, true); view.setUint16(34, bits, true); data.set(bytes('data'), 36); view.setUint32(40, bits / 8 * 3, true)
  for (const [i, value] of [-.5, 0, .5].entries()) {
    const at = 44 + i * bits / 8
    if (float) view.setFloat32(at, value, true)
    else if (bits === 16) view.setInt16(at, value * 32768, true)
    else if (bits === 32) view.setInt32(at, value * 2147483648, true)
    else { const number = value * 8388608; data[at] = number; data[at + 1] = number >> 8; data[at + 2] = number >> 16 }
  }
  return data
}
it.each([[16,false],[24,false],[32,false],[32,true]])('parses WAV %i-bit (float=%s) and preserves signed amplitude', (bits, float) => {
  const data = wav(Number(bits), Boolean(float)), info = parseWAV(data, data.length)
  expect(info.totalSamples).toBe(3)
  expect(Array.from(wavPCM(data.subarray(info.audioOffset), info.wav!)[0])).toEqual([-.5,0,.5])
  expect(info.audioOffset + Math.round(2 / 44100 * info.sampleRate) * info.wav!.align).toBe(44 + 2 * Number(bits) / 8)
})
it('rejects malformed WAV layouts rather than producing corrupted PCM', () => {
  const data = wav(16); new DataView(data.buffer).setUint16(32, 7, true)
  expect(() => parseWAV(data, data.length)).toThrow('Unsupported WAV encoding')
})
it('maps FLAC frames/SEEKTABLE and Ogg granules with bounded bisection probes', async () => {
  const flac = fixture('flac'), info = parseFLAC(flac, flac.length)
  expect(flacFrame(flac, info.audioOffset, info.blockSize!)).toMatchObject({ sample: 0, size: 4410 })
  const damaged = flac.slice(); damaged[info.audioOffset + 4] ^= 1
  expect(flacFrame(damaged, info.audioOffset, info.blockSize!)).toBeUndefined()
  const table = [{ byte: 100, sample: 0 }, { byte: 1100, sample: 44100 }, { byte: 2100, sample: 88200 }]
  expect(floorPoint(table, 70000)).toEqual(table[1])
  const points = Array.from({ length: 32 }, (_, i) => ({ byte: 100 + i * 1000, sample: i * 48000 }))
  let calls = 0
  const point = await bisectSeek(100, 32100, 10.5 * 48000, async at => { calls++; return points.filter(p => p.byte >= at).slice(0, 3) })
  expect(point).toEqual(points[10]); expect(calls).toBeLessThan(20)
  const pages = oggPages(fixture('opus'))
  expect(pages.at(-1)!.sample).toBe(5112)
  expect(pages.at(-1)!.flags & 4).toBe(4)
})
it('retains a 1 kHz tone within 0.1% and identical samples across arbitrary resampler joins', () => {
  const tone = Float32Array.from({ length: 48000 }, (_, i) => .5 * Math.sin(2 * Math.PI * 1000 * i / 48000))
  const once = new SincResampler(48000, 44100).process([tone], true)[0]
  const stream = new SincResampler(48000, 44100), chunks: Float32Array[] = [], joins: number[] = []
  let length = 0
  for (let at = 0; at < tone.length; at += 317) {
    const out = stream.process([tone.subarray(at, at + 317)], at + 317 >= tone.length)[0]
    chunks.push(out); length += out.length; joins.push(length)
  }
  const joined = new Float32Array(length); let at = 0
  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.length }
  expect(joined).toEqual(once); expect(length).toBe(44100)
  const crossings: number[] = []
  for (let i = 1; i < joined.length; i++) if (joined[i - 1] <= 0 && joined[i] > 0) crossings.push(i - 1 - joined[i - 1] / (joined[i] - joined[i - 1]))
  const hz = (crossings.length - 1) * 44100 / (crossings.at(-1)! - crossings[0])
  expect(Math.abs(hz - 1000) / 1000).toBeLessThan(.001)
  for (const join of joins.slice(0,-1)) expect(Math.abs(joined[join] - joined[join - 1])).toBeLessThan(2 * .5 * 2 * Math.PI * 1000 / 44100)
})
