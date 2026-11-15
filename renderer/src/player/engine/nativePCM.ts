import { range } from './range'
import { engineError } from './mp3'

export const NATIVE_DECODE_BUDGET = 600 * 1024 * 1024
/** One lease covers both decodeAudioData and subsequent credit-driven chunking.
 * An uncancellable OS decode keeps its lease until it settles, even after seek. */
export class NativePCM {
  private tail = Promise.resolve()
  private release?: () => void
  private buffer?: AudioBuffer
  private cursor = 0
  private opening = false
  bytes = 0
  encodedBytes = 0
  peakBytes = 0
  async open(src: string, seconds: number, context: Pick<AudioContext, 'decodeAudioData'>, signal: AbortSignal) {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    if (signal.aborted) { release(); throw new DOMException('Cancelled', 'AbortError') }
    this.release = release; this.opening = true
    const abort = () => { this.buffer = undefined; this.bytes = 0 }
    signal.addEventListener('abort', abort, { once: true })
    try {
      let head = await range(src, 0, signal)
      if (head.total > NATIVE_DECODE_BUDGET) throw new Error('Native encoded budget')
      let encoded: Uint8Array | undefined = new Uint8Array(head.total)
      this.encodedBytes = encoded.byteLength
      encoded.set(head.bytes)
      for (let offset = head.bytes.length; offset < head.total;) {
        const part = await range(src, offset, signal)
        encoded.set(part.bytes, offset); offset += part.bytes.length
      }
      // Drop the fetch slice before native decoding allocates its result.
      head = undefined
      const decoded = await context.decodeAudioData(encoded.buffer as ArrayBuffer)
      encoded = undefined; this.encodedBytes = 0
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError')
      const bytes = decoded.length * decoded.numberOfChannels * 4
      if (bytes > NATIVE_DECODE_BUDGET) throw new Error('Native PCM budget')
      this.buffer = decoded; this.bytes = bytes; this.peakBytes = Math.max(this.peakBytes, bytes)
      this.cursor = Math.min(decoded.length, Math.round(seconds * decoded.sampleRate))
      return { sampleRate: decoded.sampleRate, frames: decoded.length }
    } catch (error) {
      this.buffer = undefined; this.bytes = 0
      throw Object.assign(new Error(String(error)), engineError('decode'), error)
    } finally {
      this.opening = false; this.encodedBytes = 0
      if (!this.buffer) this.close()
      signal.removeEventListener('abort', abort)
    }
  }
  read(frames: number): { channels: Float32Array[]; done: boolean } {
    const buffer = this.buffer
    if (!buffer) return { channels: [], done: true }
    const end = Math.min(buffer.length, this.cursor + frames)
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel).slice(this.cursor, end))
    this.cursor = end
    const done = end === buffer.length
    if (done) this.close()
    return { channels, done }
  }
  close() {
    this.buffer = undefined; this.bytes = 0
    if (!this.opening) { this.encodedBytes = 0; this.release?.(); this.release = undefined }
  }
}
