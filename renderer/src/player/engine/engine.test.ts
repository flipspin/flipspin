import { describe, expect, it } from 'vitest'
import { BUFFER_SECONDS, MAX_TRACKS, TrackRing } from './ringBuffer'
import { engineError, parseMP3, seekByte, type MP3Info } from './mp3'
const pcm = (values: number[]) => ({ channels: [new Float32Array(values), new Float32Array(values)], rate: 44100 })
describe('bounded worklet track rings', () => {
  it('limits resident PCM to two tracks and 30 seconds per track in bytes', () => {
    const ring = new TrackRing(), rate = 48000
    for (let id = 1; id <= MAX_TRACKS; id++) {
      ring.add(id, rate)
      ring.push(id, { channels: [new Float32Array(rate * BUFFER_SECONDS), new Float32Array(rate * BUFFER_SECONDS)], rate })
    }
    expect(ring.bytes).toBe(MAX_TRACKS * BUFFER_SECONDS * rate * 2 * 4)
    expect(() => ring.add(3, rate)).toThrow('two-track budget')
    expect(() => ring.push(1, { channels: [new Float32Array(1), new Float32Array(1)], rate })).toThrow('PCM budget')
    ring.drop(2); expect(ring.bytes).toBe(BUFFER_SECONDS * rate * 2 * 4)
    ring.clear(); expect(ring.bytes).toBe(0)
  })
  it('splices A into B inside a quantum without inserting zeros, on the output clock', () => {
    const ring = new TrackRing(), boundaries: number[] = []
    ring.add(1, 44100); ring.push(1, pcm([1,2,3])); ring.finish(1)
    ring.add(2, 44100); ring.push(2, pcm([4,5,6,7,8])); ring.finish(2)
    const output = [new Float32Array(8), new Float32Array(8)]
    expect(ring.render(output, 44100, (_id, frame) => boundaries.push(frame))).toBe(8)
    expect(Array.from(output[0])).toEqual([1,2,3,4,5,6,7,8]); expect(boundaries).toEqual([3])
    ring.render([new Float32Array(128), new Float32Array(128)], 44100, (_id, frame) => boundaries.push(frame))
    expect(boundaries).toEqual([3,8]); expect(ring.bytes).toBe(0)
  })
  it('plays exactly 441000 trimmed frames and releases consumed chunks under refill', () => {
    const ring = new TrackRing(); ring.add(1, 44100)
    let consumed = 0
    for (let n = 0; n < 100; n++) {
      ring.push(1, { channels: [new Float32Array(4410).fill(1)], rate: 44100 })
      consumed += ring.render([new Float32Array(4410)], 44100, () => {})
      expect(ring.bytes).toBe(0)
    }
    ring.finish(1); expect(consumed).toBe(441000)
  })
  it('mixes four stems in the same output stage and applies fader values', () => {
    const ring = new TrackRing(); ring.add(1, 44100, [1, .5, 0, 0])
    ring.push(1, { channels: Array.from({ length: 8 }, () => new Float32Array(128).fill(1)), rate: 44100 })
    const output = [new Float32Array(128), new Float32Array(128)]
    ring.render(output, 44100, () => {}); expect(output[0][0]).toBe(1.5)
  })
})
describe('MP3 seek byte maps and error causes', () => {
  const info: MP3Info = { sampleRate: 44100, bitrate: 320000, duration: 100, audioOffset: 1000, bytes: 4000000, delay: 576, padding: 0 }
  it('uses first-frame bitrate for CBR and interpolates Xing TOC for VBR', () => {
    expect(seekByte(info, 50)).toBe(2001000)
    const toc = Array.from({ length: 100 }, (_, index) => index * 2)
    expect(seekByte({ ...info, toc }, 50.5)).toBe(1000 + Math.floor(101 / 256 * info.bytes))
    expect(seekByte(info, 0)).toBe(1000)
    expect(seekByte(info, 1000)).toBe(4000999)
  })
  it('parses the first MP3 header, Info TOC and LAME delay/padding; rejects non-MP3', () => {
    const bytes = new Uint8Array(2048), view = new DataView(bytes.buffer)
    bytes.set([255,251,224,0]); bytes.set(new TextEncoder().encode('Info'), 36)
    view.setUint32(40, 7); view.setUint32(44, 384); view.setUint32(48, 400000)
    bytes.set(Array.from({ length: 100 }, (_, i) => i * 2), 52)
    bytes.set(new TextEncoder().encode('LAME'), 152)
    bytes[173] = 36; bytes[174] = 0; bytes[175] = 192
    const parsed = parseMP3(bytes, 400000)
    expect(parsed).toMatchObject({ sampleRate: 44100, bitrate: 320000, delay: 576, padding: 192 })
    expect(parsed.duration).toBe((384 * 1152 - 576 - 192) / 44100)
    expect(parsed.toc).toHaveLength(100)
    expect(() => parseMP3(new TextEncoder().encode('OggS non mp3'), 12)).toThrow('notSupported')
  })
  it.each([401,404,410,503])('preserves HTTP %i as a network cause for controller policy', status => {
    expect(engineError('network', status)).toMatchObject({ code: 2, status })
  })
  it('distinguishes decoder failure from unsupported codec', () => {
    expect(engineError('decode').code).toBe(3); expect(engineError('notSupported').code).toBe(4)
  })
})
