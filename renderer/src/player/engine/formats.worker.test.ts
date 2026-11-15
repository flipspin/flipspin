import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flacFrame, floorPoint, parseFLAC, parseOgg } from './formats'
let scope: { onmessage: (event: { data: object }) => void; postMessage: ReturnType<typeof vi.fn> }
let token = 0
const fixture = (name: string) => new Uint8Array(readFileSync(resolve(import.meta.dirname, 'fixtures', name)))
const until = async (predicate: () => boolean) => {
  const start = performance.now()
  while (!predicate()) { if (performance.now() - start > 10000) throw new Error('Worker response timeout'); await new Promise(resolve => setTimeout(resolve, 1)) }
}
beforeEach(async () => {
  vi.resetModules(); scope = { onmessage: () => {}, postMessage: vi.fn() }; vi.stubGlobal('self', scope)
  await import('./decoder.worker')
})
afterEach(() => vi.unstubAllGlobals())
async function decode(data: Uint8Array, seconds = 0, rate = 44100) {
  const requests: number[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
    const match = /bytes=(\d+)-(\d+)/.exec(options.headers.Range)!
    const start = Number(match[1]), end = Math.min(Number(match[2]), data.length - 1)
    requests.push(start)
    return new Response(data.slice(start, end + 1), { status:206, headers:{ 'Content-Range':`bytes ${start}-${end}/${data.length}` } })
  }))
  const own = ++token
  const send = async (message: object) => {
    const previous = scope.postMessage.mock.calls.length
    scope.onmessage({ data:{ token:own, id:own, ...message } })
    await until(() => scope.postMessage.mock.calls.slice(previous).some(([m]) => ['metadata','pulled','done','error','native'].includes(m.type)))
    const error = scope.postMessage.mock.calls.slice(previous).find(([m]) => m.type === 'error')
    if (error) throw new Error(JSON.stringify(error[0]))
  }
  await send({ type:'start', src:'magic-only', seconds, outputRate:rate })
  const metadata = scope.postMessage.mock.calls.filter(([m]) => m.token === own && m.type === 'metadata')[0]?.[0]
  for (let pull = 0; pull < 2000; pull++) {
    await send({ type:'pull' })
    if (scope.postMessage.mock.calls.some(([m]) => m.token === own && m.type === 'done')) break
  }
  const chunks = scope.postMessage.mock.calls.filter(([m]) => m.token === own && m.type === 'pcm').map(([m]) => m.channels[0] as Float32Array)
  const samples = new Float32Array(chunks.reduce((n,c) => n + c.length,0)); let at = 0
  for (const chunk of chunks) { samples.set(chunk,at); at += chunk.length }
  return { samples, requests, metadata }
}
it.each(['flac','opus','ogg'])('streams %s through the real decoder and trims before worker resampling', async ext => {
  const data = fixture(`tone.${ext}`)
  const source = ext === 'flac' ? parseFLAC(data,data.length) : parseOgg(data,data,ext === 'opus' ? 'opus' : 'vorbis',data.length)
  const result = await decode(data)
  expect(result.metadata.rate).toBe(44100)
  expect(result.samples.length).toBe(Math.round(source.totalSamples! * 44100 / source.sampleRate))
  expect(Math.max(...result.samples)).toBeGreaterThan(.05)
})
it.each(['flac','opus','ogg'])('seeks %s by source samples with bounded probes and no decoded prefix in output', async ext => {
  const data = fixture(`seek.${ext}`), full = await decode(data)
  const seek = await decode(data, 3.2)
  expect(seek.samples.length).toBe(full.samples.length - 141120)
  expect(seek.requests.some(at => at > 0)).toBe(true)
  // Ignore the filter edge. The remainder must match the same decoded timeline.
  let difference = 0
  for (let i = 128; i < Math.min(seek.samples.length,4096); i++) difference = Math.max(difference,Math.abs(seek.samples[i] - full.samples[141120 + i]))
  expect(difference).toBeLessThan(.002)
})
it('uses a FLAC SEEKTABLE instead of probing byte estimates', async () => {
  const original = fixture('seek.flac'), info = parseFLAC(original, original.length), points = []
  for (let at = info.audioOffset; at < original.length - 16; at++) {
    const frame = flacFrame(original, at, info.blockSize!)
    if (frame) points.push(frame)
  }
  const table = new Uint8Array(4 + points.length * 18), view = new DataView(table.buffer)
  table[0] = 0x83; table[1] = (table.length - 4) >>> 16; table[2] = (table.length - 4) >>> 8; table[3] = table.length - 4
  points.forEach((p, i) => { view.setBigUint64(4 + i * 18, BigInt(p.sample)); view.setBigUint64(12 + i * 18, BigInt(p.byte - info.audioOffset)); view.setUint16(20 + i * 18, p.size) })
  const data = new Uint8Array(original.length + table.length)
  data.set(original.subarray(0, info.audioOffset))
  for (let at = 4; at < info.audioOffset;) { const size = (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]; data[at] &= 127; at += 4 + size }
  data.set(table, info.audioOffset); data.set(original.subarray(info.audioOffset),info.audioOffset + table.length)
  const parsed = parseFLAC(data,data.length), selected = floorPoint(parsed.seekTable!,3.2 * 96000)!
  const result = await decode(data,3.2)
  expect(result.requests).toEqual([0,selected.byte])
  expect(result.samples).toHaveLength(35280)
})
it('streams 24-bit stereo WAV across unaligned Range slices without dropping frames', async () => {
  const frames = 100003, data = new Uint8Array(44 + frames * 6), view = new DataView(data.buffer), text = new TextEncoder()
  data.set(text.encode('RIFF')); data.set(text.encode('WAVEfmt '),8); view.setUint32(16,16,true)
  view.setUint16(20,1,true); view.setUint16(22,2,true); view.setUint32(24,44100,true); view.setUint16(32,6,true); view.setUint16(34,24,true)
  data.set(text.encode('data'),36); view.setUint32(40,frames * 6,true)
  for (let at = 44; at < data.length; at += 3) data[at + 2] = 32
  const full = await decode(data), sought = await decode(data,1)
  expect(full.samples).toHaveLength(frames); expect(full.samples.every(value => value === .25)).toBe(true)
  expect(sought.samples).toHaveLength(frames - 44100)
  expect(sought.requests[1]).toBe(44 + 44100 * 6)
})
it('plays FLAC with an unknown STREAMINFO length instead of trimming it to silence', async () => {
  const data = fixture('tone.flac')
  data[21] &= 0xf0; data.fill(0,22,26)
  const result = await decode(data)
  expect(result.samples).toHaveLength(4410)
  expect(scope.postMessage.mock.calls.filter(([m]) => m.type === 'metadata').at(-1)![0].info.duration).toBe(.1)
})
