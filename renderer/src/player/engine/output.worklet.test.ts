import { afterEach, beforeEach, expect, it, vi } from 'vitest'
interface Processor {
  port: { onmessage: (event: { data: object }) => void; postMessage: ReturnType<typeof vi.fn> }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
}
let processor: Processor, frame: number
beforeEach(async () => {
  vi.resetModules(); frame = 0
  vi.stubGlobal('sampleRate', 44100); vi.stubGlobal('currentFrame', frame)
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: () => {}, postMessage: vi.fn() } })
  vi.stubGlobal('registerProcessor', (_name: string, Constructor: new () => Processor) => { processor = new Constructor() })
  await import('./output.worklet')
})
afterEach(() => vi.unstubAllGlobals())
const send = (data: object) => processor.port.onmessage({ data: { generation: 1, ...data } })
function render(frames: number) {
  const output = [new Float32Array(frames), new Float32Array(frames)]
  vi.stubGlobal('currentFrame', frame)
  processor.process([], [output]); frame += frames
  return Array.from(output[0])
}
function track(id: number, values: number[]) {
  send({ type: 'track', id, rate: 44100 })
  send({ type: 'pcm', id, rate: 44100, channels: [new Float32Array(values)] })
}
it('splices trimmed tracks inside a quantum and measures zero boundary frames', () => {
  send({ type: 'reset' }); send({ type: 'run', value: true })
  track(1, [1,2,3]); send({ type: 'done', id: 1 }); track(2, [4,5,6,7,8])
  expect(render(8)).toEqual([1,2,3,4,5,6,7,8])
  expect(processor.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'boundary', gapFrames: 0, audioFrame: 3 }))
})
it('measures a genuine underrun rather than reporting zero, and rejects stale PCM after seek', () => {
  send({ type: 'reset' }); send({ type: 'run', value: true })
  track(1, [1,2,3]); send({ type: 'done', id: 1 }); send({ type: 'track', id: 2, rate: 44100 })
  expect(render(8)).toEqual([1,2,3,0,0,0,0,0])
  send({ type: 'pcm', id: 2, rate: 44100, channels: [new Float32Array([4,5,6])] })
  expect(render(3)).toEqual([4,5,6])
  expect(processor.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'boundary', gapFrames: 5, audioFrame: 8 }))
  send({ type: 'reset', generation: 2 })
  track(2, [7,8,9]) // obsolete generation
  expect(render(3)).toEqual([0,0,0])
})
it('pauses the frame clock and resumes without losing queued samples', () => {
  send({ type: 'reset' }); track(1, [1,2,3,4])
  expect(render(8)).toEqual(Array(8).fill(0))
  send({ type: 'run', value: true }); expect(render(2)).toEqual([1,2])
  send({ type: 'run', value: false }); expect(render(8)).toEqual(Array(8).fill(0))
  send({ type: 'run', value: true }); expect(render(2)).toEqual([3,4])
})
it('applies the ADTS format message at the worklet boundary without changing its frame', () => {
  send({ type: 'reset' }); send({ type: 'run', value: true })
  track(1, Array(300).fill(1)); send({ type: 'done', id: 1 })
  track(2, Array(300).fill(1)); send({ type: 'format', id: 2, adts: true })
  const samples = render(600)
  expect(samples[299]).toBe(0); expect(samples[300]).toBe(0)
  expect(samples[0]).toBe(1); expect(samples[599]).toBe(1)
  expect(processor.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'boundary', audioFrame: 300, gapFrames: 0 }))
})
it('ignores stem levels on an original ring, even with the current id', () => {
  send({ type: 'reset' }); send({ type: 'run', value: true })
  track(1, [1, 2, 3])
  send({ type: 'levels', id: 1, levels: [0, 1, 0, 0] })
  expect(render(3)).toEqual([1, 2, 3])
})
it('only updates levels for the addressed stem ring', () => {
  send({ type: 'reset' }); send({ type: 'run', value: true })
  send({ type: 'track', id: 2, rate: 44100, levels: [0, 1, 0, 0] })
  send({ type: 'pcm', id: 2, rate: 44100, channels: Array.from({ length: 8 }, () => new Float32Array(44100).fill(.25)) })
  send({ type: 'levels', id: 1, levels: [0, 0, 0, 0] })
  expect(render(128)).toEqual(Array(128).fill(.25))
  send({ type: 'levels', id: 2, levels: [0, 0, 0, 0] })
  expect(render(44100 - 128).at(-1)).toBeLessThan(.00001)
})
