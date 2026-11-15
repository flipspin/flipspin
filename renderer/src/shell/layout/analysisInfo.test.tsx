import { installTestClock, clockUser, waitForClock as waitFor } from '../../test/test-clock'
import { afterEach, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import i18n from '../../i18n'
import PlayerTransport from '../../player/PlayerTransport'
import LyricsAside from '../../lyrics/LyricsAside'
import { TrackInfoHost } from '../../library/tracks/TrackInfoModal'
import { closeTrackInfo, openTrackInfo } from '../../library/tracks/trackInfoStore'

installTestClock()


const mocks = vi.hoisted(() => ({
  track: { path: '/music/Record/song.flac', relPath: 'Record/song.flac', title: 'Paper Satellites', artist: 'Ensemble', album: 'Record', key: '3A', keySource: 'computed', keyEstimated: true, bpm: 94, bpmSource: 'computed', bpmConfidence: 0.83 },
  play: vi.fn(),
}))
vi.mock('@state/AudioPlayerContext', () => ({
  useAudioPlayer: () => ({ selectedTrack: mocks.track, audioRef: { current: null }, setIsPlaying: mocks.play, queue: [] }),
  useAudioProgress: () => ({ progress: 0, duration: 180 }),
}))
vi.mock('../../state/useStatus', () => ({ useStatus: () => ({ showSuccess: vi.fn(), showError: vi.fn() }) }))
vi.mock('@state/AudioAnalyzerContext', () => ({ useAudioAnalyzer: () => ({}) }))
vi.mock('../../library/tracks/useAddToPlaylistMenu', () => ({ useAddToPlaylistMenu: () => ({ refresh: vi.fn(), submenu: () => [] }) }))
vi.mock('../../lyrics/lyricStates', async original => ({ ...await original<typeof import('../../lyrics/lyricStates')>(), useLyricStates: () => ({ states: {} }) }))

function surface(name: string, onOpenInfo?: (track: any) => void) {
  return name === 'player' ? <PlayerTransport onOpenInfo={onOpenInfo} /> : <LyricsAside onOpenInfo={onOpenInfo} t={i18n.t} track={mocks.track} cover={null} title={mocks.track.title} artist={mocks.track.artist} total={180} doc={null} source="" />
}
afterEach(() => { act(closeTrackInfo); mocks.play.mockClear() })

it.each(['player', 'lyrics'])('opens the right song from %s estimate and Flipspin chips with pointer and keyboard', async name => {
  // Pointer/keyboard activation has no typing cadence to simulate.
  const user = clockUser()
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
  const rowPlay = vi.fn()
  const { container } = render(<QueryClientProvider client={client}><div onClick={rowPlay}>{surface(name, openTrackInfo)}</div><TrackInfoHost /></QueryClientProvider>)
  for (const label of ['Estimación de Flipspin', 'Cálculo de Flipspin']) {
    const button = within(container).getByRole('button', { name: `Abrir información de la canción · ${label}` })
    for (const activate of [() => user.click(button), async () => { button.focus(); await user.keyboard('{Enter}') }, async () => { button.focus(); await user.keyboard(' ') }]) {
      await activate()
      const dialog = await waitFor(() => screen.getByRole('dialog', { name: 'Canción' }))
      expect(dialog).toHaveTextContent('Paper Satellites')
      expect(dialog).toHaveTextContent('Record/song.flac')
      expect(within(dialog).queryByRole('button', { name: /Abrir información de la canción/ })).toBeNull()
      expect(rowPlay).not.toHaveBeenCalled()
      expect(mocks.play).not.toHaveBeenCalled()
      act(closeTrackInfo)
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    }
  }
  client.clear()
})

it.each(['player', 'lyrics'])('keeps %s chips passive without an opener', name => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } })
  const { container } = render(<QueryClientProvider client={client}>{surface(name)}</QueryClientProvider>)
  expect(container.querySelector('.analysis-open-info')).toBeNull()
  expect(container.querySelectorAll('.analysis-cell')).toHaveLength(2)
  client.clear()
})
