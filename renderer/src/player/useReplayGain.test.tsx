import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useReplayGain } from './useReplayGain'
import type { ReplayGain } from './volumeLevelling'

const http = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('../data/http', () => ({ apiGet: http.get }))
beforeEach(() => { http.get.mockReset() })

it('fetches gain for playlist rows and ignores a previous song response', async () => {
  const resolvers: ((value: ReplayGain) => void)[] = []
  http.get.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)))
  const view = renderHook(({ file }) => useReplayGain('Album', file, undefined, true), { initialProps: { file: 'one.mp3' } })
  expect(view.result.current.pending).toBe(true)
  view.rerender({ file: 'two.mp3' })
  await act(async () => resolvers[0]({ trackGain: -20 }))
  expect(view.result.current.pending).toBe(true)
  expect(view.result.current.gain).toBeNull()
  await act(async () => resolvers[1]({ trackGain: -6 }))
  expect(view.result.current).toEqual({ pending: false, gain: { trackGain: -6 } })
  expect(http.get.mock.calls[0][1].signal.aborted).toBe(true)
})

it('plays with unity on an older or unavailable server', async () => {
  http.get.mockRejectedValue(new Error('404'))
  const view = renderHook(() => useReplayGain('Album', 'one.mp3', undefined, true))
  await waitFor(() => expect(view.result.current.pending).toBe(false))
  expect(view.result.current.gain).toBeNull()
})

it('keeps embedded gains offline and does not fetch when levelling is off', () => {
  const embedded = { trackGain: -3 }
  expect(renderHook(() => useReplayGain('Album', 'one.mp3', embedded, true)).result.current).toEqual({ pending: false, gain: embedded })
  expect(renderHook(() => useReplayGain('Album', 'one.mp3', undefined, false)).result.current.pending).toBe(false)
  expect(http.get).not.toHaveBeenCalled()
})


it('bounds a stalled lookup so it cannot prevent playback indefinitely', () => {
  vi.useFakeTimers()
  try {
    http.get.mockImplementation(() => new Promise(() => {}))
    const view = renderHook(() => useReplayGain('Album', 'stalled.mp3', undefined, true))
    expect(view.result.current.pending).toBe(true)
    act(() => { vi.advanceTimersByTime(3000) })
    expect(view.result.current).toEqual({ gain: null, pending: false })
    expect(http.get.mock.calls[0][1].signal.aborted).toBe(true)
    view.unmount()
  } finally { vi.useRealTimers() }
})
