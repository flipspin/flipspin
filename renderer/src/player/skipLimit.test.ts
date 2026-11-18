import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlaybackController } from './PlaybackController'
import { fakeAudio } from './fakeAudio'
import { flush } from '../stems/fakeAudio'

const track = (key: string) => ({ key, src: `https://media.example/${key}`, title: key, origin: 'https://media.example' })
const disposers: (() => void)[] = []

/** Circular queue models repeat-all; one entry also models repeat-one. */
function repeatingQueue(size: number) {
  const audio = fakeAudio(), notice = vi.fn(), fetcher = vi.fn<typeof fetch>()
  let index = 0
  const controller = new PlaybackController({
    notice, fetcher,
    advance: () => {
      index = (index + 1) % size
      // Same ordering as the provider: announce, retain intent, then commit.
      controller.prepareSelection()
      controller.setIntent(true, 'automatic')
      controller.select(track(String(index)))
    },
  })
  disposers.push(controller.attach(audio.element))
  controller.setIntent(true)
  controller.select(track('0'))
  const unsupported = async () => { audio.error(4, 200); await flush() }
  return { ...audio, controller, notice, fetcher, unsupported }
}

beforeEach(() => { vi.useFakeTimers(); localStorage.clear() })
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.useRealTimers() })

describe('consecutive unplayable songs', () => {
  it('loads exactly three of five unsupported songs, stops once, and stays stopped', async () => {
    const x = repeatingQueue(5)
    await x.unsupported(); await x.unsupported(); await x.unsupported()
    expect(x.load).toHaveBeenCalledTimes(3)
    expect(x.controller.getSnapshot()).toMatchObject({ state: 'paused', intent: false })
    expect(x.notice.mock.calls.filter(([notice]) => notice === 'consecutive')).toHaveLength(1)
    x.emit('ended'); x.error(2); x.emit('playing')
    x.controller.setConnected(false); x.controller.setConnected(true)
    await vi.advanceTimersByTimeAsync(60000)
    expect(x.load).toHaveBeenCalledTimes(3)
    expect(x.fetcher).not.toHaveBeenCalled()
    expect(x.controller.getSnapshot()).toMatchObject({ state: 'paused', intent: false })
    expect(x.notice.mock.calls.filter(([notice]) => notice === 'consecutive')).toHaveLength(1)
  })

  it.each(['one', 'all'])('stops after one unsupported song with repeat-%s', async () => {
    const x = repeatingQueue(1)
    await x.unsupported()
    expect(x.load).toHaveBeenCalledTimes(1)
    expect(x.controller.getSnapshot()).toMatchObject({ state: 'paused', intent: false })
    await vi.advanceTimersByTimeAsync(60000)
    expect(x.load).toHaveBeenCalledTimes(1)
    expect(x.notice.mock.calls.filter(([notice]) => notice === 'consecutive')).toHaveLength(1)
  })

  it('stops a two-song repeat-all lap before requesting the first song again', async () => {
    const x = repeatingQueue(2)
    await x.unsupported(); await x.unsupported()
    expect(x.load).toHaveBeenCalledTimes(2)
    expect(x.controller.getSnapshot()).toMatchObject({ state: 'paused', intent: false })
    await vi.advanceTimersByTimeAsync(60000)
    expect(x.load).toHaveBeenCalledTimes(2)
    expect(x.notice.mock.calls.filter(([notice]) => notice === 'consecutive')).toHaveLength(1)
  })

  it('resets on first playing after two failures, so a later failure skips again', async () => {
    const x = repeatingQueue(5)
    await x.unsupported(); await x.unsupported()
    x.emit('loadedmetadata'); x.emit('playing')
    expect(x.controller.getSnapshot().state).toBe('playing')
    await x.unsupported()
    expect(x.load).toHaveBeenCalledTimes(4)
    expect(x.controller.getSnapshot()).toMatchObject({ state: 'loading', intent: true })
    expect(x.notice.mock.calls.some(([notice]) => notice === 'consecutive')).toBe(false)
  })

  it('a user play after the stop reloads and gives a fresh skip budget', async () => {
    const x = repeatingQueue(5)
    await x.unsupported(); await x.unsupported(); await x.unsupported()
    x.controller.setIntent(true)
    expect(x.load).toHaveBeenCalledTimes(4)
    await x.unsupported(); await x.unsupported()
    expect(x.load).toHaveBeenCalledTimes(6)
    expect(x.controller.getSnapshot()).toMatchObject({ state: 'loading', intent: true })
    await x.unsupported()
    expect(x.controller.getSnapshot()).toMatchObject({ state: 'paused', intent: false })
    expect(x.notice.mock.calls.filter(([notice]) => notice === 'consecutive')).toHaveLength(2)
  })

  it.each(['chosen', '2', '0'])('selecting %s after the stop loads even before play intent is set', async key => {
    const x = repeatingQueue(5)
    await x.unsupported(); await x.unsupported(); await x.unsupported()
    x.controller.select(track(key))
    expect(x.load).toHaveBeenCalledTimes(4)
    expect(x.element.src).toBe(track(key).src)
    x.controller.setIntent(true, 'automatic')
    x.emit('loadedmetadata'); await flush(); x.emit('playing')
    expect(x.controller.getSnapshot()).toMatchObject({ state: 'playing', intent: true })
  })

  it('can explicitly pick and replay the same track after a short lap stops', async () => {
    const x = repeatingQueue(1)
    await x.unsupported()
    x.controller.userAction()
    x.controller.setIntent(true)
    expect(x.load).toHaveBeenCalledTimes(2)
    await x.unsupported()
    expect(x.load).toHaveBeenCalledTimes(2)
    expect(x.controller.getSnapshot()).toMatchObject({ state: 'paused', intent: false })
    expect(x.notice.mock.calls.filter(([notice]) => notice === 'consecutive')).toHaveLength(2)
  })
})
