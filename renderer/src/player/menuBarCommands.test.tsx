import { playbackEngine } from './engine/PlaybackEngine'
import { renderHook, act } from '@testing-library/react'
import { useState, useRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setFakeBridgeForTest } from '../bridge'
import type { KrobiBridge } from '../lib/ipc'
import { useMediaSession } from '../state/useMediaSession'

describe('menu-bar playback rows', () => {
  let restore = () => {}
  afterEach(() => restore())

  it('Play/Pause toggles, Next and Previous move through the queue', () => {
    const listeners: Array<(command: string) => void> = []
    restore = setFakeBridgeForTest({
      invoke: vi.fn(),
      on: (channel: string, listener: (command: string) => void) => {
        if (channel === 'player:command') listeners.push(listener)
        return () => {}
      },
    } as unknown as KrobiBridge)
    const next = vi.fn()
    const previous = vi.fn()
    const { result } = renderHook(() => {
      const [isPlaying, setIsPlaying] = useState(false)
      const nextRef = useRef(next)
      const prevRef = useRef(previous)
      useMediaSession({ nowPlaying: null, isPlaying, setIsPlaying, nextRef, prevRef })
      return isPlaying
    })
    act(() => listeners.forEach((l) => l('toggle')))
    expect(result.current).toBe(true)
    act(() => listeners.forEach((l) => l('toggle')))
    expect(result.current).toBe(false)
    act(() => listeners.forEach((l) => l('next')))
    act(() => listeners.forEach((l) => l('previous')))
    expect(next).toHaveBeenCalledOnce()
    expect(previous).toHaveBeenCalledOnce()
  })
})

it('Media Session reads the engine clock and routes play, pause, seek and queue actions', () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaSession')
  const duration = playbackEngine.duration
  let position = 42
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>()
  const session = {
    playbackState: 'none',
    setActionHandler: vi.fn((action: MediaSessionAction, handler: MediaSessionActionHandler | null) => handlers.set(action, handler)),
    setPositionState: vi.fn(),
  }
  Object.defineProperty(navigator, 'mediaSession', { configurable: true, value: session })
  vi.spyOn(playbackEngine, 'currentTime', 'get').mockImplementation(() => position)
  vi.spyOn(playbackEngine, 'currentTime', 'set').mockImplementation(value => { position = value })
  playbackEngine.duration = 180
  const next = vi.fn(), previous = vi.fn()
  const { result, unmount } = renderHook(() => {
    const [isPlaying, setIsPlaying] = useState(false)
    useMediaSession({ nowPlaying: null, isPlaying, setIsPlaying, nextRef: useRef(next), prevRef: useRef(previous) })
    return isPlaying
  })
  try {
    act(() => handlers.get('play')!({ action: 'play' }))
    expect(result.current).toBe(true); expect(session.playbackState).toBe('playing')
    playbackEngine.dispatchEvent(new Event('timeupdate'))
    expect(session.setPositionState).toHaveBeenLastCalledWith({ duration: 180, position: 42, playbackRate: 1 })
    act(() => handlers.get('pause')!({ action: 'pause' }))
    expect(result.current).toBe(false)
    handlers.get('seekto')!({ action: 'seekto', seekTime: 66 })
    playbackEngine.dispatchEvent(new Event('seeked'))
    expect(session.setPositionState).toHaveBeenLastCalledWith({ duration: 180, position: 66, playbackRate: 1 })
    handlers.get('nexttrack')!({ action: 'nexttrack' }); handlers.get('previoustrack')!({ action: 'previoustrack' })
    expect(next).toHaveBeenCalledOnce(); expect(previous).toHaveBeenCalledOnce()
    unmount(); expect(handlers.get('seekto')).toBeNull()
  } finally {
    unmount(); vi.restoreAllMocks(); playbackEngine.duration = duration
    if (descriptor) Object.defineProperty(navigator, 'mediaSession', descriptor)
    else Reflect.deleteProperty(navigator, 'mediaSession')
  }
})
