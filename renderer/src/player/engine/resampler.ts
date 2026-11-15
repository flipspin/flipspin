/** Streaming 64-tap Blackman-windowed sinc, with a quantized polyphase bank.
 * The phase and history span input chunks; only EOF extends the last sample.
 * No filter latency is added to the output timeline. */
export class SincResampler {
  private readonly radius = 32
  private readonly phases = 1024
  private bank: Float64Array[]
  private buffers: Float32Array[] = []
  private base = 0
  private input = 0
  private output = 0
  constructor(readonly inputRate: number, readonly outputRate: number) {
    if (inputRate === outputRate) { this.bank = []; return }
    const cutoff = Math.min(1, outputRate / inputRate) * .94
    this.bank = Array.from({ length: this.phases + 1 }, (_, phase) => {
      const fraction = phase / this.phases
      const taps = Float64Array.from({ length: this.radius * 2 }, (_, tap) => {
        const x = tap - this.radius + 1 - fraction, y = Math.PI * x * cutoff
        const window = .42 + .5 * Math.cos(Math.PI * x / this.radius) + .08 * Math.cos(2 * Math.PI * x / this.radius)
        return (Math.abs(y) < 1e-12 ? cutoff : Math.sin(y) / (Math.PI * x)) * window
      })
      const sum = taps.reduce((a, b) => a + b, 0)
      return taps.map(x => x / sum)
    })
  }
  process(channels: Float32Array[], final = false): Float32Array[] {
    if (this.inputRate === this.outputRate) return channels.map(c => c.slice())
    if (!channels[0]?.length) {
      if (!final || !this.buffers.length) return channels.map(() => new Float32Array())
      channels = this.buffers.map(() => new Float32Array())
    }
    if (!this.buffers.length) this.buffers = channels.map(() => new Float32Array())
    this.buffers = this.buffers.map((old, i) => {
      const joined = new Float32Array(old.length + channels[i].length)
      joined.set(old); joined.set(channels[i], old.length); return joined
    })
    this.input += channels[0]?.length || 0
    const end = final ? Math.round(this.input * this.outputRate / this.inputRate) : Math.max(this.output, Math.ceil((this.input - this.radius) * this.outputRate / this.inputRate))
    const result = channels.map(() => new Float32Array(end - this.output))
    for (let out = this.output; out < end; out++) {
      const position = out * this.inputRate / this.outputRate, center = Math.floor(position)
      const taps = this.bank[Math.round((position - center) * this.phases)]
      for (let ch = 0; ch < result.length; ch++) {
        let value = 0
        for (let tap = 0; tap < taps.length; tap++) {
          const index = Math.max(0, Math.min(this.input - 1, center + tap - this.radius + 1)) - this.base
          value += this.buffers[ch][index] * taps[tap]
        }
        result[ch][out - this.output] = value
      }
    }
    this.output = end
    const discard = Math.max(0, Math.floor(end * this.inputRate / this.outputRate) - this.radius - this.base)
    this.buffers = this.buffers.map(c => c.slice(discard)); this.base += discard
    return result
  }
}
