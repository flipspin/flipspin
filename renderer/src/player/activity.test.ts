import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setFakeBridgeForTest } from '../bridge'
import type { KrobiBridge } from '../lib/ipc'
import { PlaybackController } from './PlaybackController'
import { fakeAudio } from './fakeAudio'
import { flush } from '../stems/fakeAudio'

let detach: (() => void) | undefined
let undo: (() => void) | undefined
beforeEach(() => { vi.useFakeTimers(); localStorage.clear() })
afterEach(() => { detach?.(); undo?.(); vi.useRealTimers() })
function setup() {
  const invoke = vi.fn(async () => ({ ok: true }))
  const activity = vi.fn()
  invoke.mockImplementation(async (channel?: unknown, request?: unknown) => { if (channel === 'playback:activity') activity(channel, request); return { ok: true } })
  undo = setFakeBridgeForTest({ invoke, on: () => () => {} } as KrobiBridge)
  const audio = fakeAudio()
  const controller = new PlaybackController({ advance: vi.fn(), notice: vi.fn() })
  detach = controller.attach(audio.element)
  controller.select({ key: 'album/song', src: 'media', origin: 'https://nest.example', title: 'Song' })
  controller.setIntent(true)
  return { ...audio, controller, invoke: activity }
}
it('holds through loading, playing, waiting and retries, releases on pause and stop', async () => {
  const x = setup()
  expect(x.invoke).toHaveBeenLastCalledWith('playback:activity', { active: true, reason: 'Playing music' })
  x.emit('loadedmetadata'); x.emit('playing'); x.emit('waiting'); x.error(2, 503)
  await flush()
  expect(x.controller.getSnapshot().state).toBe('retrying')
  expect(x.invoke).toHaveBeenCalledTimes(1)
  x.controller.setIntent(false)
  expect(x.invoke).toHaveBeenLastCalledWith('playback:activity', { active: false, reason: 'Playing music' })
  x.controller.setIntent(true)
  expect(x.invoke).toHaveBeenLastCalledWith('playback:activity', { active: true, reason: 'Playing music' })
  x.controller.select(null)
  expect(x.invoke).toHaveBeenLastCalledWith('playback:activity', { active: false, reason: 'Playing music' })
})
it('releases when ended without another selection and when detached', () => {
  const x = setup()
  x.emit('loadedmetadata'); x.emit('playing'); x.emit('ended')
  expect(x.invoke).toHaveBeenLastCalledWith('playback:activity', { active: false, reason: 'Playing music' })
  x.controller.setIntent(true)
  expect(x.invoke).toHaveBeenLastCalledWith('playback:activity', { active: true, reason: 'Playing music' })
  detach?.()
  expect(x.invoke).toHaveBeenLastCalledWith('playback:activity', { active: false, reason: 'Playing music' })
})
