export interface AACPacket { data: Uint8Array; timestamp: number; duration: number }
export interface AACPCM { channels: Float32Array[]; timestamp: number; rate: number }
/** Shared by worker and main-thread bridge; only one bounded batch is outstanding. */
export class AACDecoder {
  private decoder?: AudioDecoder
  private output: AACPCM[] = []
  private error?: Error
  static async supported(config: AudioDecoderConfig) {
    if (typeof AudioDecoder === 'undefined') return false
    try { return (await AudioDecoder.isConfigSupported(config)).supported === true } catch { return false }
  }
  open(config: AudioDecoderConfig) {
    this.close(); this.error = undefined
    this.decoder = new AudioDecoder({
      output: data => {
        try {
          const channels = Array.from({ length: data.numberOfChannels }, (_, planeIndex) => {
            const channel = new Float32Array(data.numberOfFrames)
            data.copyTo(channel, { planeIndex, format: 'f32-planar' }); return channel
          })
          this.output.push({ channels, timestamp: data.timestamp, rate: data.sampleRate })
        } catch (error) { this.error = error as Error } finally { data.close() }
      },
      error: error => { this.error = error },
    })
    this.decoder.configure(config)
  }
  async decode(packets: AACPacket[]) {
    const decoder = this.decoder!
    for (const packet of packets) decoder.decode(new EncodedAudioChunk({ type: 'key', ...packet, data: packet.data as Uint8Array<ArrayBuffer> }))
    await decoder.flush()
    if (this.error) throw this.error
    const output = this.output; this.output = []
    return output
  }
  close() { if (this.decoder && this.decoder.state !== 'closed') this.decoder.close(); this.decoder = undefined; this.output = [] }
}
