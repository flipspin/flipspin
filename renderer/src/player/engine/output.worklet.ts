import { TrackRing } from './ringBuffer'
// Worklet globals are absent from TypeScript's DOM library.
declare const sampleRate: number
declare const currentFrame: number
declare class AudioWorkletProcessor { port: MessagePort }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void
class PlaybackOutput extends AudioWorkletProcessor {
  private ring = new TrackRing()
  private generation = 0
  private running = false
  private audible = false
  private ticks = 0
  private boundary?: { id: number; frame: number }
  constructor() {
    super()
    this.port.onmessage = ({ data: m }) => {
      if (m.type === 'reset') { this.generation = m.generation; this.ring.clear(); this.boundary = undefined; this.audible = false }
      if (m.generation !== this.generation) return
      if (m.type === 'track') this.ring.add(m.id, m.rate, m.levels)
      if (m.type === 'pcm') { this.ring.push(m.id, m); this.report() }
      if (m.type === 'format') this.ring.format(m.id, m.adts)
      if (m.type === 'done') this.ring.finish(m.id)
      if (m.type === 'drop') this.ring.drop(m.id)
      if (m.type === 'run') this.running = m.value
      if (m.type === 'levels') {
        const track = this.ring.tracks[0]
        if (track?.levels && track.id === m.id) track.levels = m.levels
      }
    }
  }
  private report() {
    this.port.postMessage({ type: 'clock', generation: this.generation, tracks: this.ring.tracks.map(t => ({ id: t.id, frames: t.frames, played: t.played, rate: t.rate })), bytes: this.ring.bytes })
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    if (!this.running) return true
    const frames = this.ring.render(outputs[0], sampleRate, (id, frame, next) => {
      this.boundary = { id, frame }
      this.port.postMessage({ type: 'end', generation: this.generation, id, frame, audioFrame: currentFrame + frame - this.ring.outputFrames, next })
    }, (id, frame) => {
      if (this.boundary) this.port.postMessage({ type: 'boundary', generation: this.generation, from: this.boundary.id, id, gapFrames: frame - this.boundary.frame, frame, audioFrame: currentFrame + frame - this.ring.outputFrames })
      this.boundary = undefined
    })
    if (frames > 0 && !this.audible) {
      this.audible = true
      this.port.postMessage({ type: 'playing', generation: this.generation, audioFrame: currentFrame })
    }
    if (frames < outputs[0][0].length && this.audible) {
      this.audible = false
      this.port.postMessage({ type: 'waiting', generation: this.generation, audioFrame: currentFrame + frames })
    }
    // Credit/clock at ~50 Hz; main thread emits timeupdate at 4 Hz.
    if (++this.ticks >= Math.ceil(sampleRate / 128 / 50)) { this.ticks = 0; this.report() }
    return true
  }
}
registerProcessor('krobi-playback', PlaybackOutput)
