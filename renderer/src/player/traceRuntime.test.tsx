import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { log } from '../lib/log'
import { trace, traceGain, traceStore } from './trace'
import TraceOverlay from './TraceOverlay'

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks() })
it('buffers trace rows for two seconds, measures playback, and toggles the dev overlay', () => {
  vi.useFakeTimers(); vi.stubEnv('KROBI_PLAYBACK_TRACE', '1')
  const debug = vi.spyOn(log.playback, 'debug').mockImplementation(() => {})
  vi.advanceTimersByTime(10)
  trace('request', 1, 'album/song')
  vi.advanceTimersByTime(100); trace('playing', 1, 'album/song')
  trace('waiting', 1, 'album/song')
  vi.advanceTimersByTime(200); trace('playing', 1, 'album/song')
  trace('seeking', 1, 'album/song')
  vi.advanceTimersByTime(40); trace('seeked', 1, 'album/song')
  traceGain({ mode: 'track', chosen: 'track', dB: -2.5, linear: 0.75, clipped: false })
  trace('failed', 1, 'album/song', { cause: 'network' })
  expect(traceStore.getSnapshot()).toMatchObject({ startup: 100, rebufferCount: 1, rebufferMs: 200, seekMs: 40, gain: 0.75, lastError: 'network', cacheHit: null })
  expect(debug).not.toHaveBeenCalled()
  render(<TraceOverlay />)
  expect(screen.queryByLabelText('Diagnóstico de reproducción')).not.toBeInTheDocument()
  fireEvent.keyDown(window, { code: 'KeyP', altKey: true, metaKey: true })
  expect(screen.getByLabelText('Diagnóstico de reproducción')).toHaveTextContent('Sin datos')
  expect(screen.getByLabelText('Diagnóstico de reproducción')).toHaveTextContent('0.750')
  trace('boundary', 2, 'album/next', { ms: 0, frame: 441000 })
  trace('ended', 1, 'album/song')
  vi.advanceTimersByTime(20); trace('request', 2, 'album/next')
  vi.advanceTimersByTime(30); trace('playing', 2, 'album/next')
  act(() => vi.advanceTimersByTime(1610))
  expect(debug).toHaveBeenCalledOnce()
  const rows = debug.mock.calls[0][1] as { event: string; ms?: number; session: number; key: string; t: number }[]
  expect(rows.find(row => row.event === 'boundary')).toMatchObject({ ms: 0, session: 2, key: 'album/next' })
  expect(rows.every(row => Number.isFinite(row.t))).toBe(true)
  for (let n = 0; n < 300; n++) trace('stalled', 2, 'album/next')
  act(() => vi.advanceTimersByTime(2000))
  expect((debug.mock.calls[1][1] as unknown[]).length).toBe(256)
  fireEvent.keyDown(window, { code: 'KeyP', altKey: true, metaKey: true })
  expect(screen.queryByLabelText('Diagnóstico de reproducción')).not.toBeInTheDocument()
})
