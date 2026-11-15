import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ImportPanel } from './ImportPanel'
import { previewPlaylist, importPlaylist } from './gateway'
import { track } from '../downloads/downloadsStore'
import { openSettings } from '../shell/ServerBadge'
import { peekLanding } from '../settings/landing'

const status = vi.hoisted(() => ({ current: { isPending: false, isSuccess: true, data: { configured: true, connected: false } as unknown } }))



vi.mock('./gateway', () => ({ previewPlaylist: vi.fn(), importPlaylist: vi.fn(), downloadFromYoutube: vi.fn() }))
vi.mock('../downloads/downloadsStore', () => ({ track: vi.fn() }))
vi.mock('../shell/ServerBadge', () => ({ openSettings: vi.fn() }))
vi.mock('../data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../data')>()),
  useSpotifyStatus: () => status.current,
}))

const wrap = (ui: ReactNode) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
const setStatus = (next: Partial<typeof status.current>) => { status.current = { isPending: false, isSuccess: true, data: { configured: true }, ...next } }

beforeEach(() => { vi.clearAllMocks(); setStatus({}) })

describe('Import form navigation', () => {
  it('has two sources, Playlist and YouTube, switched with arrow keys and one tab stop', () => {
    render(wrap(<ImportPanel />))
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Playlist', 'YouTube'])
    const playlist = screen.getByRole('tab', { name: 'Playlist' })
    fireEvent.keyDown(playlist, { key: 'ArrowRight' })
    expect(screen.getByRole('tab', { name: 'YouTube' })).toHaveFocus()
    expect(screen.getByLabelText('Enlace del vídeo')).toBeVisible()
    expect(playlist).toHaveAttribute('tabindex', '-1')
  })
  it('previews then submits the same playlist through the existing download store', async () => {
    vi.mocked(previewPlaylist).mockResolvedValue({ name: 'My list', trackCount: 2, coverUrl: null })
    vi.mocked(importPlaylist).mockResolvedValue({ progressId: 'job-1', total: 2 })
    render(wrap(<ImportPanel />))
    const url = 'https://open.spotify.com/playlist/example'
    fireEvent.change(screen.getByLabelText('Enlace de la playlist'), { target: { value: url } })
    fireEvent.click(screen.getByRole('button', { name: 'Ver qué trae' }))
    await screen.findByText('My list')
    fireEvent.click(screen.getByRole('button', { name: 'Importar 2 canciones' }))
    await waitFor(() => expect(importPlaylist).toHaveBeenCalledWith(url, 2))
    expect(track).toHaveBeenCalledWith({ id: 'job-1', label: 'My list', total: 2 })
  })
})

describe('Spotify credentials', () => {
  it('configured → the playlist form', () => {
    render(wrap(<ImportPanel />))
    expect(screen.getByLabelText('Enlace de la playlist')).toBeEnabled()
    expect(screen.queryByText('Spotify sin configurar')).toBeNull()
  })
  it('not configured → the state and one button that opens Fuentes', () => {
    setStatus({ data: { configured: false, connected: false } })
    render(wrap(<ImportPanel />))
    expect(screen.getByText('Spotify sin configurar')).toBeTruthy()
    expect(screen.queryByLabelText('Enlace de la playlist')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Configurar Spotify' }))
    expect(openSettings).toHaveBeenCalledWith('fuentes')
    expect(peekLanding('spotify-keys')).toBe(true)
  })
  it('still loading → the form, disabled', () => {
    setStatus({ isPending: true, isSuccess: false, data: undefined })
    render(wrap(<ImportPanel />))
    expect(screen.getByLabelText('Enlace de la playlist')).toBeDisabled()
  })
  it('status error → the form as before (fail open)', () => {
    setStatus({ isPending: false, isSuccess: false, data: undefined })
    render(wrap(<ImportPanel />))
    expect(screen.getByLabelText('Enlace de la playlist')).toBeEnabled()
  })
  it('YouTube works without Spotify keys', () => {
    setStatus({ data: { configured: false } })
    render(wrap(<ImportPanel />))
    fireEvent.click(screen.getByRole('tab', { name: 'YouTube' }))
    expect(screen.getByLabelText('Enlace del vídeo')).toBeEnabled()
  })
})
