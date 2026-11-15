import { describe, expect, it, vi } from 'vitest'
import { NowPlayingAnchor } from './nowPlayingAnchor'

function fakeElement() {
  const element = document.createElement('audio')
  let paused = true
  Object.defineProperty(element, 'paused', { get: () => paused })
  element.play = vi.fn(async () => { paused = false })
  element.pause = vi.fn(() => { paused = true })
  return element
}

describe('Now Playing anchor (media keys)', () => {
  it('loops silent WAV media and mirrors play and pause', async () => {
    URL.createObjectURL ??= () => 'blob:silence'
    URL.revokeObjectURL ??= () => {}
    const element = fakeElement()
    const anchor = new NowPlayingAnchor(() => element)
    anchor.play()
    await Promise.resolve()
    expect(element.loop).toBe(true)
    expect(element.src).toContain('blob:')
    expect(element.play).toHaveBeenCalledTimes(1)
    anchor.play()
    expect(element.play).toHaveBeenCalledTimes(1)
    anchor.pause()
    expect(element.pause).toHaveBeenCalledTimes(1)
    anchor.dispose()
    expect(element.isConnected).toBe(false)
  })
  it('a refused play (no gesture yet) is swallowed', async () => {
    URL.createObjectURL ??= () => 'blob:silence'
    const element = fakeElement()
    element.play = vi.fn(() => Promise.reject(new DOMException('no gesture', 'NotAllowedError')))
    const anchor = new NowPlayingAnchor(() => element)
    expect(() => anchor.play()).not.toThrow()
    await Promise.resolve()
  })
})
