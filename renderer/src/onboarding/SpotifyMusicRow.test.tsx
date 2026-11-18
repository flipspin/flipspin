import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import { SpotifyMusicRow } from './SpotifyMusicRow'

afterEach(() => { delete (window as { desktopAPI?: unknown }).desktopAPI })

it('opens Spotify’s data page in one click, with the steps in its tooltip', async () => {
  await i18n.changeLanguage('en')
  const openExternal = vi.fn(async () => undefined)
  ;(window as { desktopAPI?: unknown }).desktopAPI = { openExternal }
  render(<SpotifyMusicRow onClose={() => {}} />)
  const button = screen.getByRole('button', { name: 'Get it from Spotify' })
  expect(button.getAttribute('title')).toMatch(/^1\. Under Download your data/)
  await userEvent.click(button)
  expect(openExternal).toHaveBeenCalledWith('https://www.spotify.com/account/privacy/')
})
