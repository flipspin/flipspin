export const BUFFER_SECONDS = 30
export const MAX_TRACKS = 2
export interface PCMChunk { channels: Float32Array[]; rate: number }
interface Track {
  id: number; chunks: PCMChunk[]; offset: number; frames: number; bytes: number
  adts?: boolean; fadeIn?: boolean
  played: number; rate: number; done: boolean; levels?: number[]; smooth?: number[]
}
function sample(track: Track, channel: number, index: number, fraction: number) {
  const data = track.chunks[0].channels[channel]
  const first = data[index]
  const second = data[index + 1] ?? track.chunks[1]?.channels[channel]?.[0] ?? first
  return first + (second - first) * fraction
}
/** Bounded FIFO of track rings. A splice can happen inside a render quantum. */
export class TrackRing {
  tracks: Track[] = []
  outputFrames = 0
  get bytes() { return this.tracks.reduce((sum, track) => sum + track.bytes, 0) }
  add(id: number, rate: number, levels?: number[]) {
    if (this.tracks.some(track => track.id === id)) return
    if (this.tracks.length === MAX_TRACKS) throw new RangeError('two-track budget')
    this.tracks.push({ id, rate, chunks: [], offset: 0, frames: 0, bytes: 0, played: 0, done: false, levels, smooth: levels?.slice() })
  }
  push(id: number, chunk: PCMChunk) {
    const track = this.tracks.find(track => track.id === id)
    if (!track) return
    const frames = chunk.channels[0]?.length || 0
    if (!frames) return
    if (!chunk.channels.length || chunk.channels.length > 8 || chunk.channels.some(channel => channel.length !== frames) || track.frames + frames > BUFFER_SECONDS * chunk.rate) throw new RangeError('PCM budget')
    track.rate = chunk.rate
    track.chunks.push(chunk); track.frames += frames
    track.bytes += chunk.channels.reduce((sum, channel) => sum + channel.byteLength, 0)
  }
  format(id: number, adts: boolean) { const track = this.tracks.find(t => t.id === id); if (track) track.adts = adts }
  finish(id: number) { const track = this.tracks.find(track => track.id === id); if (track) track.done = true }
  clear() { this.tracks = [] }
  drop(id: number) { this.tracks = this.tracks.filter(track => track.id !== id) }
  render(output: Float32Array[], outputRate: number, ended: (id: number, frame: number, next?: number) => void, started?: (id: number, frame: number) => void): number {
    let written = 0
    const smoothing = 1 - Math.exp(-1 / (outputRate * .015))
    for (let frame = 0; frame < output[0].length; frame++) {
      let track = this.tracks[0]
      while (track?.done && !track.chunks.length) {
        this.tracks.shift()
        if (this.tracks[0]) this.tracks[0].fadeIn = !!(track.adts || this.tracks[0].adts)
        ended(track.id, this.outputFrames + frame, this.tracks[0]?.id)
        track = this.tracks[0]
      }
      if (!track?.chunks.length) continue
      if (track.played === 0) started?.(track.id, this.outputFrames + frame)
      const chunk = track.chunks[0], index = Math.floor(track.offset)
      const fraction = track.offset - index
      if (track.levels) {
        for (let stem = 0; stem < track.levels.length; stem++) track.smooth![stem] += (track.levels[stem] - track.smooth![stem]) * smoothing
      }
      const fadeFrames = Math.max(2, Math.round(track.rate * .003))
      let gain = track.fadeIn ? Math.sin(Math.min(1, track.played / (fadeFrames - 1)) * Math.PI / 2) : 1
      const next = this.tracks[1]
      if (track.done && next && (track.adts || next.adts)) {
        const remaining = track.frames - track.offset
        gain *= Math.sin(Math.min(1, Math.max(0, remaining - 1) / (fadeFrames - 1)) * Math.PI / 2)
      }
      for (let channel = 0; channel < output.length; channel++) {
        let value = 0
        if (track.levels) {
          for (let stem = 0; stem < track.levels.length; stem++) value += sample(track, stem * 2 + channel, index, fraction) * track.smooth![stem]
        } else value = sample(track, Math.min(channel, chunk.channels.length - 1), index, fraction)
        output[channel][frame] = value * gain
      }
      const step = track.rate / outputRate
      track.offset += step; track.played += step; written++
      if (track.offset >= chunk.channels[0].length) {
        track.offset -= chunk.channels[0].length
        track.chunks.shift(); track.frames -= chunk.channels[0].length
        track.bytes -= chunk.channels.reduce((sum, channel) => sum + channel.byteLength, 0)
      }
    }
    this.outputFrames += output[0].length
    return written
  }
}
