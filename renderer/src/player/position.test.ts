import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearPosition, persistPosition, POSITION_KEY, readPosition, restoreSeconds } from './position'
import { PlaybackController } from './PlaybackController'
import { fakeAudio } from './fakeAudio'

const origin = 'https://nest.example', key = 'album/song'
const disposers: (() => void)[] = []
beforeEach(() => { vi.useFakeTimers(); localStorage.clear() })
afterEach(() => { disposers.splice(0).forEach(fn => fn()); vi.useRealTimers(); vi.restoreAllMocks() })
describe('C7 device position', () => {
  it('writes at 5 s only while playing, and on pause, seeked, pagehide', () => {
    const audio = fakeAudio()
    let playing = true
    audio.element.currentTime = 20
    disposers.push(persistPosition(audio.element, origin, key, () => playing, () => audio.element.currentTime))
    vi.advanceTimersByTime(4999); expect(localStorage.getItem(POSITION_KEY)).toBeNull()
    vi.advanceTimersByTime(1)
    expect(readPosition(origin, key, localStorage)).toEqual({ origin, key, seconds: 20, savedAt: Date.now() })
    playing = false; audio.element.currentTime = 25; vi.advanceTimersByTime(5000)
    expect(readPosition(origin, key, localStorage)?.seconds).toBe(20)
    for (const event of ['pause', 'seeked', 'pagehide']) {
      audio.element.currentTime++
      if (event === 'pagehide') window.dispatchEvent(new Event(event)); else audio.emit(event)
      expect(readPosition(origin, key, localStorage)?.seconds).toBe(audio.element.currentTime)
    }
    clearPosition(); expect(localStorage.getItem(POSITION_KEY)).toBeNull()
  })
  it.each([[-1, false], [5, false], [5.01, true], [169.99, true], [170, false], [180, false], [Infinity, false]])('restores %s only strictly within the bounds', (seconds, allowed) => {
    expect(restoreSeconds({ origin, key, seconds, savedAt: 0 }, 180)).toBe(allowed ? seconds : null)
  })
  it('rejects malformed data, other origins and other songs', () => {
    localStorage.setItem(POSITION_KEY, '{')
    expect(readPosition(origin, key, localStorage)).toBeNull()
    localStorage.setItem(POSITION_KEY, JSON.stringify({ origin, key, seconds: 42, savedAt: 1 }))
    expect(readPosition('https://other.example', key, localStorage)).toBeNull()
    expect(readPosition(origin, 'other', localStorage)).toBeNull()
  })
  it('seeks after metadata on launch, never autoplays, and removes position on song change', () => {
    const audio = fakeAudio()
    localStorage.setItem(POSITION_KEY, JSON.stringify({ origin, key, seconds: 42, savedAt: 1 }))
    const controller = new PlaybackController({ advance: vi.fn(), notice: vi.fn() })
    disposers.push(controller.attach(audio.element))
    controller.select({ origin, key, src: 'krobi-media://localhost/album/song', title: 'Song' })
    expect(audio.element.currentTime).toBe(0)
    audio.emit('loadedmetadata')
    expect(audio.element.currentTime).toBe(42)
    expect(controller.getSnapshot().state).toBe('paused')
    expect(audio.play).not.toHaveBeenCalled()
    audio.emit('seeked')
    expect(readPosition(origin, key, localStorage)?.seconds).toBe(42)
    controller.select({ origin, key: 'album/other', src: 'krobi-media://localhost/album/other', title: 'Other' })
    expect(localStorage.getItem(POSITION_KEY)).toBeNull()
    audio.emit('loadedmetadata'); expect(audio.element.currentTime).toBe(0)
    expect(audio.play).not.toHaveBeenCalled()
  })
  it('persists the single engine clock and removes all listeners on teardown', () => {
    const audio = fakeAudio()
    const controller = new PlaybackController({ advance: vi.fn(), notice: vi.fn() })
    const detach = controller.attach(audio.element)
    controller.select({ origin, key, src: 'media', title: 'Song' })
    audio.emit('loadedmetadata'); controller.setIntent(true); audio.emit('playing'); audio.element.currentTime = 66; audio.emit('timeupdate')
    vi.advanceTimersByTime(5000)
    expect(readPosition(origin, key, localStorage)?.seconds).toBe(66)
    detach(); clearPosition(); audio.emit('pause'); window.dispatchEvent(new Event('pagehide')); vi.advanceTimersByTime(5000)
    expect(localStorage.getItem(POSITION_KEY)).toBeNull()
  })
  it('never restores an old position into a song selected before metadata', () => {
    const audio = fakeAudio()
    localStorage.setItem(POSITION_KEY, JSON.stringify({ origin, key, seconds: 42, savedAt: 1 }))
    const controller = new PlaybackController({ advance: vi.fn(), notice: vi.fn() })
    disposers.push(controller.attach(audio.element))
    controller.select({ origin, key, src: 'media', title: 'Song' })
    controller.select({ origin, key: 'album/other', src: 'other', title: 'Other' })
    audio.emit('loadedmetadata')
    expect(audio.element.currentTime).toBe(0)
    expect(audio.play).not.toHaveBeenCalled()
  })
})
