import { afterEach, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { render } from '../library/tracks/songMenuTestSupport'
import i18n from '../i18n'
import Home from './home'

vi.mock('@state/AudioPlayerContext', () => ({ useAudioPlayer: () => ({ play: vi.fn(), addToQueue: vi.fn(), addNextInQueue: vi.fn() }) }))
vi.mock('../state/useStatus', () => ({ useStatus: () => ({ showSuccess: vi.fn(), showError: vi.fn() }) }))
vi.mock('@lib/playHistory', () => ({ usePlayHistory: () => ({}) }))
vi.mock('@lib/playlistSummaries', () => ({ fetchPlaylistSummaries: async () => [] }))
vi.mock('./useHomeRows', () => ({ useHomeRows: () => null }))
vi.mock('../offline/useOfflineStorage', () => ({ useOfflineStorage: () => ({ data: null }) }))
vi.mock('../downloads/acquisitionJobs', async importOriginal => ({
  ...await importOriginal<typeof import('../downloads/acquisitionJobs')>(),
  useAcquisitionJobs: () => ({ requests: [], who: null, accountId: null, error: false, stageIds: new Set<string>() }),
}))

afterEach(async () => { await i18n.changeLanguage('es') })

// Captured before the source-key migration; all five Home panels are real.
it.each(['es', 'en'])('preserves Home text content in %s', async language => {
  await i18n.changeLanguage(language)
  const view = render(<Home albums={[]} onOpenPlaylist={vi.fn()} />)
  await act(async () => {})
  expect(view.container.textContent).toMatchSnapshot()
})
