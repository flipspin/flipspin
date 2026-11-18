/** Event-compatible transport; audioRef is retained by UI adapters, never a DOM node. */
export interface PlaybackPort extends EventTarget {
  src: string
  currentTime: number
  readonly duration: number
  readonly paused: boolean
  readonly ended: boolean
  readonly error: { code: number; status?: number; message?: string } | null
  volume: number
  load(): void
  play(): Promise<void>
  pause(): void
  setNext?(track: { key: string; src: string; cached?: boolean } | null): void
}
export interface StemSource {
  duration: number
  sampleRate: number
  read(start: number, frames: number): Float32Array[]
  levels: number[]
}
