import { vi } from 'vitest'
import type { PlaybackPort } from './engine/PlaybackPort'
export function fakeAudio() {
  class FakeEngine extends EventTarget implements PlaybackPort {
    src = ''; currentTime = 0; duration = 180; paused = true; ended = false; volume = 1
    error: PlaybackPort['error'] = null
    getAttribute(name: string) { return name === 'src' ? this.src : null }
    load = vi.fn(() => { this.currentTime = 0; this.paused = true; emit('loadstart') })
    play = vi.fn(async () => { this.paused = false })
    pause = vi.fn(() => { this.paused = true; emit('pause') })
    setNext = vi.fn()
  }
  const element = new FakeEngine()
  const emit = (name: string) => element.dispatchEvent(new Event(name))
  return { element, emit, load: element.load, play: element.play, pause: element.pause,
    error: (code: number, status?: number) => { element.error = { code, status }; emit('error') } }
}
