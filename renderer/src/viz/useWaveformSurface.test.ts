import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { fakeAudio } from '../player/fakeAudio'
import { useAudioPlaying } from './useWaveformSurface'
describe('useAudioPlaying with the engine port', () => {
  it('observes play and pause from the same port for original and stems', () => {
    const { element: engine, emit } = fakeAudio()
    const connectAudio = vi.fn(), resume = vi.fn()
    const { result } = renderHook(() => useAudioPlaying({ current: engine }, connectAudio, resume))
    expect(result.current).toBe(false)
    act(() => emit('play'))
    expect(connectAudio).toHaveBeenCalledWith(engine); expect(result.current).toBe(true)
    act(() => emit('pause')); expect(result.current).toBe(false)
  })
  it('shows playing at mount when the drawer opens during playback', () => {
    const { element: engine } = fakeAudio(); engine.paused = false
    const { result } = renderHook(() => useAudioPlaying({ current: engine }, vi.fn(), vi.fn()))
    expect(result.current).toBe(true)
  })
})
