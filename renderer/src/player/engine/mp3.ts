export interface MP3Info {
  sampleRate: number; bitrate: number; duration: number; audioOffset: number
  bytes: number; toc?: number[]; delay: number; padding: number
}
const text = (data: Uint8Array, start: number, size: number) => String.fromCharCode(...data.subarray(start, start + size))
export function id3Size(data: Uint8Array): number {
  return text(data, 0, 3) === 'ID3' ? 10 + ((data[6] & 127) * 2097152 + (data[7] & 127) * 16384 + (data[8] & 127) * 128 + (data[9] & 127)) + (data[5] & 16 ? 10 : 0) : 0
}
/** Inspect the first Layer III frame, without decoding an entire song. */
export function parseMP3(data: Uint8Array, totalBytes: number, base = 0): MP3Info {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let i = base ? 0 : id3Size(data); i + 4 < data.length; i++) {
    const h = view.getUint32(i), version = (h >>> 19) & 3, layer = (h >>> 17) & 3
    const br = (h >>> 12) & 15, sr = (h >>> 10) & 3
    if ((h >>> 21) !== 2047 || version === 1 || layer !== 1 || !br || br === 15 || sr === 3) continue
    const mpeg1 = version === 3
    const bitrate = (mpeg1 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[br] * 1000
    const sampleRate = [44100,48000,32000][sr] / (mpeg1 ? 1 : version === 2 ? 2 : 4)
    const frameSize = Math.floor((mpeg1 ? 144 : 72) * bitrate / sampleRate) + ((h >>> 9) & 1)
    if (i + frameSize > data.length) continue
    const audioOffset = base + i
    const info: MP3Info = { sampleRate, bitrate, audioOffset, bytes: totalBytes - audioOffset, duration: (totalBytes - audioOffset) * 8 / bitrate, delay: 0, padding: 0 }
    const mono = ((h >>> 6) & 3) === 3
    const x = i + 4 + ((h & 0x10000) ? 0 : 2) + (mpeg1 ? mono ? 17 : 32 : mono ? 9 : 17)
    if (!['Xing','Info'].includes(text(data, x, 4))) return info
    const flags = view.getUint32(x + 4)
    let cursor = x + 8, frames = 0
    if (flags & 1) { frames = view.getUint32(cursor); cursor += 4 }
    if (flags & 2) { info.bytes = view.getUint32(cursor); cursor += 4 }
    if (flags & 4) { info.toc = Array.from(data.subarray(cursor, cursor + 100)); cursor += 100 }
    if (flags & 8) cursor += 4
    if (cursor + 24 <= data.length && /^(LAME|Lavf|Lavc)/.test(text(data, cursor, 4))) {
      info.delay = (data[cursor + 21] << 4) | (data[cursor + 22] >>> 4)
      info.padding = ((data[cursor + 22] & 15) << 8) | data[cursor + 23]
    }
    if (frames) info.duration = (frames * (mpeg1 ? 1152 : 576) - info.delay - info.padding) / sampleRate
    return info
  }
  throw new Error('notSupported')
}
export function seekByte(info: MP3Info, seconds: number): number {
  const fraction = Math.max(0, Math.min(1, seconds / info.duration))
  let offset: number
  if (info.toc?.length === 100) {
    const p = fraction * 100, index = Math.min(99, Math.floor(p))
    offset = (info.toc[index] + ((info.toc[index + 1] ?? 256) - info.toc[index]) * (p - index)) / 256 * info.bytes
  } else offset = seconds * info.bitrate / 8
  return Math.min(info.audioOffset + info.bytes - 1, info.audioOffset + Math.max(0, Math.floor(offset)))
}
export function engineError(cause: 'network' | 'decode' | 'notSupported', status = 0, message: string = cause) {
  return { code: cause === 'network' ? 2 : cause === 'decode' ? 3 : 4, status, message }
}
