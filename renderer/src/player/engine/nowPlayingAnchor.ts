/**
 * macOS routes the media keys (⏮ ⏯ ⏭, AirPods, the Now Playing widget) to the
 * app that owns "Now Playing", and WebKit claims it only while an HTMLMediaElement
 * plays. Engine A plays through an AudioWorklet, so without this anchor the keys
 * reach nothing. The anchor is a hidden element looping silence that mirrors the
 * engine's play/pause; the audible output stays the engine's alone.
 */
const SECONDS = 30 // short media is ignored by WebKit's Now Playing heuristics
const RATE = 8000

function silentWav(): Blob {
  const samples = SECONDS * RATE
  const view = new DataView(new ArrayBuffer(44 + samples * 2))
  const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i)) }
  text(0, 'RIFF'); view.setUint32(4, 36 + samples * 2, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, RATE, true); view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  text(36, 'data'); view.setUint32(40, samples * 2, true)
  return new Blob([view.buffer], { type: 'audio/wav' })
}

export class NowPlayingAnchor {
  private element?: HTMLAudioElement
  private url?: string
  constructor(private create: () => HTMLAudioElement = () => document.createElement('audio')) {}
  private ensure(): HTMLAudioElement | undefined {
    if (this.element) return this.element
    if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return undefined
    const element = this.create()
    element.loop = true
    element.preload = 'auto'
    element.setAttribute('aria-hidden', 'true')
    element.style.display = 'none'
    this.url = URL.createObjectURL(silentWav())
    element.src = this.url
    document.body?.appendChild(element)
    this.element = element
    return element
  }
  play(): void {
    const element = this.ensure()
    if (!element || !element.paused) return
    // A refusal (no gesture yet) only costs the media keys until the next play.
    void Promise.resolve(element.play()).catch(() => {})
  }
  pause(): void { if (this.element && !this.element.paused) this.element.pause() }
  dispose(): void {
    this.element?.pause(); this.element?.remove(); this.element = undefined
    if (this.url) URL.revokeObjectURL(this.url); this.url = undefined
  }
}
