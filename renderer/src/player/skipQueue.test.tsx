import React from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioPlayerProvider, useAudioPlayer } from '../state/AudioPlayerContext'
import { playbackEngine } from './engine/PlaybackEngine'
import { playbackNotice } from './notices'
import { flush } from '../stems/fakeAudio'

const automatic = vi.hoisted(() => ({ advance: () => {} }))
vi.mock('./PlaybackController', async importOriginal => {
  const { PlaybackController } = await importOriginal<typeof import('./PlaybackController')>()
  return { PlaybackController: class extends PlaybackController {
    constructor(options: ConstructorParameters<typeof PlaybackController>[0]) {
      super(options)
      automatic.advance = options.advance
    }
  } }
})

vi.mock('./engine/PlaybackEngine', async () => {
  const { fakeAudio } = await import('./fakeAudio')
  return { playbackEngine: fakeAudio().element }
})
vi.mock('./notices', () => ({ playbackNotice: vi.fn() }))
vi.mock('./useReplayGain', () => ({ useReplayGain: () => ({ gain: null, pending: false }) }))
vi.mock('../stems/audioGraph', () => ({ setLevellingGain: vi.fn() }))
vi.mock('../stems/StemPlayer', () => ({ stemPlayer: { setTrack: vi.fn() } }))
vi.mock('../stems/background', () => ({ createBackgroundPreSplit: () => ({ schedule: vi.fn(), cancel: vi.fn() }) }))

const wrapper = ({ children }: { children?: React.ReactNode }) => <AudioPlayerProvider>{children}</AudioPlayerProvider>
const tracks = Array.from({ length: 7 }, (_, n) => ({ path: `Album/${n}.mp3`, relPath: `Album/${n}.mp3`, title: String(n) }))
const engine = playbackEngine
const unsupported = async () => {
  await act(async () => { engine.error = { code: 4, status: 200 }; engine.dispatchEvent(new Event('error')); await flush() })
}
const notices = () => vi.mocked(playbackNotice).mock.calls.filter(([notice]) => notice === 'consecutive')

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); vi.useFakeTimers(); engine.currentTime = 0 })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('provider automatic skips and explicit actions', () => {
  it.each(['selection', 'replay', 'pick', 'album', 'queue', 'next', 'previous', 'media-next', 'media-previous', 'media-play'] as const)('%s loads and plays after the stop', async action => {
    const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>()
    vi.stubGlobal('navigator', { mediaSession: { setActionHandler: (key: MediaSessionAction, fn: MediaSessionActionHandler | null) => handlers.set(key, fn) } })
    const { result } = renderHook(useAudioPlayer, { wrapper })
    act(() => result.current.setQueueWithTracks(tracks))
    await unsupported(); await unsupported(); await unsupported()
    expect(notices()).toHaveLength(1)
    act(() => {
      if (action === 'selection') result.current.play(tracks[3], { replaceQueue: true, upcomingTracks: tracks.slice(4) })
      if (action === 'replay') result.current.play(tracks[2])
      if (action === 'pick') result.current.setSelectedTrack(tracks[3])
      if (action === 'album') result.current.setQueueWithTracks(tracks.slice(3))
      if (action === 'queue') result.current.playQueueItemAt(0)
      if (action === 'next') result.current.goNext()
      if (action === 'previous') result.current.goPrevious()
      if (action === 'media-next') handlers.get('nexttrack')?.({ action: 'nexttrack' })
      if (action === 'media-previous') handlers.get('previoustrack')?.({ action: 'previoustrack' })
      if (action === 'media-play') handlers.get('play')?.({ action: 'play' })
    })
    const chosen = action === 'previous' || action === 'media-previous' ? tracks[1]
      : action === 'replay' || action === 'media-play' ? tracks[2] : tracks[3]
    expect(engine.load).toHaveBeenCalledTimes(4)
    expect(engine.src).toContain(chosen.relPath)
    expect(result.current.nowPlaying).toEqual(chosen)
    await act(async () => { engine.dispatchEvent(new Event('loadedmetadata')); await flush() })
    expect(engine.play).toHaveBeenCalled()
    act(() => engine.dispatchEvent(new Event('playing')))
    expect(result.current).toMatchObject({ playerState: 'playing', isPlaying: true })
  })

  it('play after the stop resets the budget before the selected song plays', async () => {
    const { result } = renderHook(useAudioPlayer, { wrapper })
    act(() => result.current.setQueueWithTracks(tracks))
    await unsupported(); await unsupported(); await unsupported()
    act(() => result.current.play(tracks[3], { replaceQueue: true, upcomingTracks: tracks.slice(4) }))
    await unsupported(); await unsupported()
    expect(result.current).toMatchObject({ playerState: 'loading', nowPlaying: tracks[5], isPlaying: true })
    expect(notices()).toHaveLength(1)
    await unsupported()
    expect(result.current).toMatchObject({ playerState: 'paused', isPlaying: false })
    expect(notices()).toHaveLength(2)
  })

  it('blocks both a late engine ended and the context automatic advance after the stop', async () => {
    const { result } = renderHook(useAudioPlayer, { wrapper })
    act(() => result.current.setQueueWithTracks(tracks))
    await unsupported(); await unsupported(); await unsupported()
    const stopped = result.current
    act(() => engine.dispatchEvent(new Event('ended')))
    expect(result.current.nowPlaying).toEqual(stopped.nowPlaying)
    act(() => automatic.advance())
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(engine.load).toHaveBeenCalledTimes(3)
    expect(result.current).toMatchObject({ playerState: 'paused', isPlaying: false, nowPlaying: stopped.nowPlaying, queue: stopped.queue, history: stopped.history })
    expect(notices()).toHaveLength(1)
  })

  it('preserves failures through the real queue, then a user play starts a fresh budget', async () => {
    const { result } = renderHook(useAudioPlayer, { wrapper })
    act(() => result.current.setQueueWithTracks(tracks.slice(0, 5)))
    await unsupported(); await unsupported(); await unsupported()
    expect(engine.load).toHaveBeenCalledTimes(3)
    expect(result.current).toMatchObject({ playerState: 'paused', isPlaying: false, nowPlaying: tracks[2], queue: tracks.slice(3, 5) })
    expect(engine.paused).toBe(true)
    expect(notices()).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(engine.load).toHaveBeenCalledTimes(3)
    act(() => result.current.setIsPlaying(true))
    await unsupported(); await unsupported()
    expect(engine.load).toHaveBeenCalledTimes(6)
    expect(result.current.nowPlaying).toEqual(tracks[4])
    expect(notices()).toHaveLength(1)
  })

  it.each(['pick', 'selection', 'album', 'queue', 'next', 'previous', 'play', 'media-next', 'media-play'] as const)('%s resets two automatic failures', async action => {
    const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>()
    vi.stubGlobal('navigator', { mediaSession: { setActionHandler: (key: MediaSessionAction, fn: MediaSessionActionHandler | null) => handlers.set(key, fn) } })
    const { result } = renderHook(useAudioPlayer, { wrapper })
    act(() => result.current.setQueueWithTracks(tracks))
    await unsupported(); await unsupported()
    act(() => {
      if (action === 'pick') result.current.setSelectedTrack(tracks[3], { playNow: false })
      if (action === 'selection') result.current.play(tracks[3], { replaceQueue: true, upcomingTracks: tracks.slice(4) })
      if (action === 'album') result.current.setQueueWithTracks(tracks.slice(3))
      if (action === 'queue') result.current.playQueueItemAt(0)
      if (action === 'next') result.current.goNext()
      if (action === 'previous') result.current.goPrevious()
      if (action === 'play') result.current.setIsPlaying(true)
      if (action === 'media-next') handlers.get('nexttrack')?.({ action: 'nexttrack' })
      if (action === 'media-play') handlers.get('play')?.({ action: 'play' })
    })
    await unsupported(); await unsupported()
    expect(notices()).toHaveLength(0)
    await unsupported()
    expect(result.current.playerState).toBe('paused')
    expect(notices()).toHaveLength(1)
  })
})
