import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { DataProvider } from '../../data'
import { setLanguage } from '../../i18n'
import { SettingsProvider } from '../context'
import { serverStatus } from '../test-support'
import { installMusicBoundary } from '../../uploads/onboardingTestSupport'
import { __resetLyricsStoreForTest } from '../../lyrics/lyricsStore'
import { ThisComputer } from './ThisComputer'

let boundary: ReturnType<typeof installMusicBoundary> | undefined
afterEach(() => { cleanup(); boundary?.restore(); boundary = undefined; __resetLyricsStoreForTest(); setLanguage('es') })
it('toggles the shell keep-awake preference from General, independently of a batch', async () => {
  setLanguage('en')
  boundary = installMusicBoundary({ batch: null })
  render(<DataProvider><SettingsProvider value={{
    surface: 'app', admin: false, me: null, meStatus: null, mePending: false, meError: null, refreshMe: vi.fn(),
    server: { kind: 'ready', value: serverStatus({ mode: 'external' }) }, refreshServer: vi.fn(), go: vi.fn(),
    host: { palette: 'paper', setPalette: vi.fn(), palettes: [], mode: 'dark', setMode: vi.fn() },
  }}><ThisComputer /></SettingsProvider></DataProvider>)
  const toggle = await screen.findByRole('switch', { name: 'Keep Flipspin and this computer awake during uploads' })
  await waitFor(() => expect(toggle).toBeEnabled())
  expect(toggle).toBeChecked()
  await userEvent.click(toggle)
  await waitFor(() => expect(toggle).not.toBeChecked())
  expect(boundary.invocations).toContainEqual({ channel: 'upload:keep-awake', request: { enabled: false } })
  await userEvent.click(toggle)
  await waitFor(() => expect(toggle).toBeChecked())
  expect(boundary.invocations.at(-1)).toEqual({ channel: 'upload:keep-awake', request: { enabled: true } })
})
