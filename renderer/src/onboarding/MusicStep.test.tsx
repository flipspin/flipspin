// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { DataProvider } from '../data'
import { installFakeSettings, type FakeSettings } from '../settings/test-support'
import { MusicStep } from './MusicStep'

let fake: FakeSettings | null = null
afterEach(() => { fake?.restore(); fake = null; vi.unstubAllGlobals() })
const albums = Array.from({ length: 15 }, (_, i) => `Album ${i + 1}`)
const summary = { folder: '/music', songs: 2856, albums: 179, artists: 97 }
function start(empty = false) {
  fake = installFakeSettings({ respond: r => {
    if (r.pathname === '/api/library/summary') return { status: 200, json: empty ? { ...summary, songs: 0 } : summary }
    if (r.pathname === '/api/listar-albums-con-metadata') return { status: 200, json: albums.map(album => ({ album })) }
    return undefined
  } })
  const done = vi.fn()
  render(<DataProvider><MusicStep host={null} localNest={false} onDone={done} /></DataProvider>)
  return done
}
it('uses the real summary, previews only twelve album names and returns them on Next', async () => {
  const done = start()
  expect(await screen.findByText('2,856')).toBeInTheDocument()
  expect(screen.getByText('179')).toBeInTheDocument()
  expect(screen.getByText('97')).toBeInTheDocument()
  await screen.findByText('Album 12')
  expect(document.querySelectorAll('.kob-tiles > i')).toHaveLength(12)
  expect(screen.queryByText('Album 13')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Seleccionar' })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
  expect(done).toHaveBeenCalledWith(summary, albums.slice(0, 12))
})
it('mounts the existing Spotify export importer over the wizard and refreshes music on close', async () => {
  start()
  await screen.findByText('2,856')
  await userEvent.click(screen.getByRole('button', { name: 'Importar' }))
  // The importer is lazy-loaded; wait for its module and the mounted dialog.
  const dialog = await screen.findByRole('dialog', { name: 'Importar desde Spotify' }, { timeout: 4000 })
  expect(await within(dialog).findByRole('button', { name: 'Elegir archivo de Spotify' }, { timeout: 4000 })).toBeInTheDocument()
  expect(fake!.requests.some(r => r.pathname.includes('spotify-export'))).toBe(false)
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cerrar' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(await screen.findByRole('heading', { name: 'Tu música' })).toBeInTheDocument()
  await waitFor(() => expect(fake!.requests.filter(r => r.pathname === '/api/library/summary')).toHaveLength(2), { timeout: 3000 })
})
it('keeps zero songs truthful, with mount guidance in a tooltip and refresh available', async () => {
  start(true)
  const empty = await screen.findByText('Vacío')
  expect(empty).toHaveAttribute('title', expect.stringContaining('Docker'))
  expect(screen.getAllByRole('radio')).toHaveLength(2)
  expect(screen.queryByText('-v /ruta/a/tu/musica:/music')).toBeNull()
  expect(screen.getByRole('button', { name: 'Siguiente' })).toBeEnabled()
})

it('opens four Spotify steps in a popover and opens privacy settings in the system browser', async () => {
  start()
  const external = vi.fn()
  vi.stubGlobal('desktopAPI', { openExternal: external })
  expect(screen.queryByRole('dialog')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Cómo conseguirlo' }))
  const popover = screen.getByRole('dialog', { name: 'Cómo conseguirlo' })
  expect(popover).not.toHaveAttribute('aria-modal')
  const steps = within(popover).getAllByRole('listitem')
  expect(steps.map(step => step.textContent)).toEqual([
    'Abre la configuración de privacidad de Spotify',
    'En Descargar tus datos, marca Datos de la cuenta y solicítalos',
    'Confirma el correo que te envía Spotify',
    'Cuando llegue el archivo (Spotify dice que puede tardar unos días), suelta el .zip aquí',
  ])
  const link = within(popover).getByRole('link', { name: 'Abre la configuración de privacidad de Spotify' })
  expect(link).toHaveAttribute('href', 'https://www.spotify.com/account/privacy/')
  await userEvent.click(link)
  expect(external).toHaveBeenCalledWith('https://www.spotify.com/account/privacy/')
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})
