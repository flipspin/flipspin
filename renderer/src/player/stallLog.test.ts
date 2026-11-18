import { afterEach, expect, it, vi } from 'vitest'
import { PlaybackController } from './PlaybackController'
import { fakeAudio } from './fakeAudio'
import { log } from '../lib/log'

let detach: (() => void) | undefined
afterEach(() => { detach?.(); vi.useRealTimers(); vi.restoreAllMocks(); localStorage.clear() })
function setup() {
  vi.useFakeTimers()
  const warn = vi.spyOn(log.playback, 'warn').mockImplementation(() => {})
  const audio = fakeAudio()
  const controller = new PlaybackController({ advance: vi.fn(), notice: vi.fn() })
  detach = controller.attach(audio.element)
  controller.setIntent(true)
  controller.select({ key: 'A/song.mp3', title: 'Song', src: 'krobi-media://localhost/api/media/A/song.mp3', origin: 'https://nest.example' })
  return { controller, warn, ...audio }
}
it('logs a startup wait once with local source and a separate mid-song wait', async () => {
  const x = setup()
  x.element.dispatchEvent(new CustomEvent('firstByte', { detail: { cacheHit: true, src: x.element.src } }))
  await vi.advanceTimersByTimeAsync(500)
  expect(x.warn).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(x.warn).toHaveBeenCalledWith('playback stall', expect.objectContaining({ song: 'A/song.mp3', source: 'local', position: 0, waitMs: 501 }))
  await vi.advanceTimersByTimeAsync(3000)
  expect(x.warn).toHaveBeenCalledTimes(1)
  x.emit('loadedmetadata'); x.emit('playing')
  x.element.currentTime = 42; x.emit('timeupdate'); x.emit('waiting'); x.emit('waiting')
  await vi.advanceTimersByTimeAsync(501)
  expect(x.warn).toHaveBeenCalledTimes(2)
  expect(x.warn).toHaveBeenLastCalledWith('playback stall', expect.objectContaining({ position: 42, source: 'local', waitMs: 501 }))
})
it('does not log short waits or cancelled playback, and reports server playback', async () => {
  const x = setup()
  x.element.dispatchEvent(new CustomEvent('firstByte', { detail: { cacheHit: false, src: x.element.src } }))
  x.emit('loadedmetadata'); x.emit('playing'); x.emit('waiting')
  await vi.advanceTimersByTimeAsync(200)
  x.emit('playing')
  await vi.advanceTimersByTimeAsync(501)
  expect(x.warn).not.toHaveBeenCalled()
  x.emit('waiting'); await vi.advanceTimersByTimeAsync(501)
  expect(x.warn).toHaveBeenCalledTimes(1)
  expect(x.warn).toHaveBeenLastCalledWith('playback stall', expect.objectContaining({ source: 'server' }))
  x.emit('playing'); x.emit('waiting'); x.controller.setIntent(false)
  await vi.advanceTimersByTimeAsync(1000)
  expect(x.warn).toHaveBeenCalledTimes(1)
})
