import { AACRanges, aacSeek, adtsHeader, type AACTrack } from './aac'
import { audioInfo, type AudioInfo } from './formats'
import { AACDecoder, type AACPacket, type AACPCM } from './aacDecoder'
import { SincResampler } from './resampler'

export interface AACCodec {
  supported(config: AudioDecoderConfig): Promise<boolean>
  open(config: AudioDecoderConfig): Promise<void> | void
  decode(packets: AACPacket[]): Promise<AACPCM[]>
  close(): void
}
export class AACStream {
  info!: AudioInfo
  private track?: AACTrack
  private index = 0
  private byte = 0
  private position = 0
  private target = 0
  private resampler!: SincResampler
  private codec!: AACCodec
  private config!: AudioDecoderConfig
  private adts = false
  done = false
  location = 'worker'
  constructor(private ranges: AACRanges, private signal: AbortSignal, readonly outputRate: number) {}
  async open(adts: boolean, seconds: number, bridge?: AACCodec) {
    this.adts = adts
    if (adts) {
      const bytes = await this.ranges.read(0, 7)
      let first: ReturnType<typeof adtsHeader>
      try { first = adtsHeader(bytes) } catch (error) {
        if (String(error).includes('Unsupported ADTS')) return false
        throw error
      }
      this.config = first.config
      // No guessed priming or padding. Exact ADTS duration is published at EOF.
      this.info = audioInfo('aac', this.config.sampleRate, Math.floor(this.ranges.total / first.size) * 1024, this.ranges.total)
      this.info.adts = true
    } else {
      this.track = await this.ranges.mp4()
      if (!this.track) return false
      this.config = this.track.config
      this.info = { ...audioInfo('aac', this.config.sampleRate, this.track.frames, this.ranges.total), delay: this.track.delay, padding: this.track.padding }
    }
    const local = new AACDecoder()
    const worker: AACCodec = { supported: AACDecoder.supported, open: config => local.open(config), decode: packets => local.decode(packets), close: () => local.close() }
    if (await worker.supported(this.config)) this.codec = worker
    else if (bridge && await bridge.supported(this.config)) { this.codec = bridge; this.location = 'main' }
    else return false
    if (this.signal.aborted) return false
    await this.codec.open(this.config)
    if (this.signal.aborted) { this.close(); return false }
    this.target = Math.round(seconds * this.config.sampleRate) + (this.track?.delay || 0)
    if (this.track) this.index = aacSeek(this.track.samples, this.target)
    else if (seconds > 0) {
      // ADTS has no index. Walk headers without retaining payloads, including VBR.
      let previous = 0, previousPosition = 0
      while (this.byte < this.ranges.total && this.position + 1024 <= this.target) {
        const header = adtsHeader(await this.ranges.read(this.byte, 7))
        previous = this.byte; previousPosition = this.position
        this.byte += header.size; this.position += 1024
      }
      this.byte = previous; this.position = previousPosition
    }
    this.resampler = new SincResampler(this.config.sampleRate, this.outputRate)
    return true
  }
  async read() {
    const packets: AACPacket[] = [], rate = this.config.sampleRate
    for (let i = 0; i < 16; i++) {
      let byte: number, size: number, start: number, duration: number
      if (this.track) {
        const sample = this.track.samples[this.index++]
        if (!sample) break
        ;({ byte, size, start, duration } = sample)
      } else {
        if (this.byte >= this.ranges.total) break
        const header = adtsHeader(await this.ranges.read(this.byte, 7))
        if (header.config.sampleRate !== rate || header.config.numberOfChannels !== this.config.numberOfChannels) throw new Error('Changing ADTS configuration')
        byte = this.byte + header.header; size = header.size - header.header
        start = this.position; duration = 1024
        this.byte += header.size; this.position += duration
      }
      const data = (await this.ranges.read(byte, size)).slice()
      packets.push({ data, timestamp: Math.round(start * 1e6 / rate), duration: Math.round(duration * 1e6 / rate) })
    }
    const eof = this.track ? this.index >= this.track.samples.length : this.byte >= this.ranges.total
    const output = packets.length ? await this.codec.decode(packets) : []
    if (this.signal.aborted) return []
    const trimmed: Float32Array[][] = []
    let frames = 0
    for (const block of output) {
      if (block.rate !== rate) throw new Error('Unexpected AAC output rate')
      const start = Math.round(block.timestamp * rate / 1e6), length = block.channels[0].length
      const from = Math.min(length, Math.max(0, this.target - start))
      const to = Math.max(from, Math.min(length, (this.track ? this.track.delay + this.track.frames : Infinity) - start))
      trimmed.push(block.channels.map(channel => channel.subarray(from, to))); frames += to - from
    }
    const channels = Array.from({ length: this.config.numberOfChannels }, (_, ch) => {
      const joined = new Float32Array(frames); let at = 0
      for (const block of trimmed) { joined.set(block[ch], at); at += block[ch].length }
      return joined
    })
    this.done = eof
    if (eof && this.adts) { this.info.totalSamples = this.position; this.info.duration = this.position / rate }
    const result = this.resampler.process(channels, eof)
    if (eof) this.close()
    return result
  }
  close() { this.codec?.close() }
}
