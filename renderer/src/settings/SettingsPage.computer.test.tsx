import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { pluginAddons, pluginPages, pluginSettingsSections } from '../plugins'
import { fake, renderPage } from './page-test-support'

describe('SettingsPage', () => {
  it('defaults volume levelling to Auto and saves the General choice', async () => {
    renderPage({ section: 'equipo' })
    const group = await screen.findByRole('radiogroup', { name: 'Nivelación de volumen' })
    expect(within(group).getByRole('radio', { name: 'Automática' })).toHaveAttribute('aria-checked', 'true')
    expect(within(group).queryByRole('radio', { name: 'Pista' })).not.toBeInTheDocument()
    await userEvent.click(within(group).getByRole('radio', { name: 'Canción' }))
    expect(localStorage.getItem('krobi.volumeLevelling')).toBe('track')
    await userEvent.click(within(group).getByRole('radio', { name: 'Álbum' }))
    expect(localStorage.getItem('krobi.volumeLevelling')).toBe('album')
    await userEvent.click(within(group).getByRole('radio', { name: 'Desactivada' }))
    expect(localStorage.getItem('krobi.volumeLevelling')).toBe('off')
  })

  it('keeps the General mode control without a palette picker', async () => {
    const setMode = vi.fn()
    renderPage({ section: 'equipo', host: { mode: 'dark', setMode } })
    expect(await screen.findByRole('heading', { level: 2, name: 'General' })).toBeInTheDocument()
    const mode = screen.getByRole('radiogroup', { name: 'Modo' })
    expect(within(mode).getByRole('radio', { name: 'Oscuro' })).toHaveAttribute('aria-checked', 'true')
    for (const label of ['Claro', 'Oscuro', 'Noche']) expect(within(mode).getByRole('radio', { name: label })).toBeVisible()
    await userEvent.click(within(mode).getByRole('radio', { name: 'Noche' }))
    expect(setMode).toHaveBeenCalledWith('night')
    expect(screen.queryByRole('radiogroup', { name: 'Paleta' })).not.toBeInTheDocument()
    expect(screen.queryByText('Paleta')).not.toBeInTheDocument()
    expect(screen.queryByText('Paper')).not.toBeInTheDocument()
  })

  it('summarizes General with language and mode', async () => {
    renderPage({ host: { mode: 'night' } })
    expect(await screen.findByRole('heading', { level: 2, name: 'Resumen' })).toBeInTheDocument()
    expect(screen.getByRole('main')).toHaveTextContent('Español · Noche')
    expect(screen.queryByText(/Paper|Paleta/)).not.toBeInTheDocument()
  })

  it('«Este equipo»: the VLC row configures, changes and forgets the one address', async () => {
    const setVlcIp = vi.fn()
    const first = renderPage({ section: 'equipo', host: { setVlcIp } })
    expect(await screen.findByText('sin configurar')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Configurar' }))
    await userEvent.type(screen.getByLabelText('Dirección de VLC'), '192.0.2.50')
    await userEvent.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(setVlcIp).toHaveBeenCalledWith('192.0.2.50')
    first.unmount()
    pluginAddons.length = 0
  pluginSettingsSections.length = 0
  pluginPages.length = 0
  fake?.restore()

    const forget = vi.fn()
    renderPage({ section: 'equipo', host: { vlcIp: '192.0.2.50', setVlcIp: forget } })
    expect(await screen.findByText('192.0.2.50')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cambiar' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Quitar' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar' }))
    await userEvent.click(screen.getByRole('button', { name: 'Quitar' }))
    expect(forget).toHaveBeenCalledWith('')
    await userEvent.click(screen.getByRole('button', { name: 'Deshacer' }))
    expect(forget).toHaveBeenLastCalledWith('192.0.2.50')
  })

  it('Vite development hides native actions without a shell', async () => {
    renderPage({ section: 'nido', surface: 'dev' })
    expect(await screen.findByRole('heading', { level: 2, name: /Estado del nido/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cambiar de nido' })).not.toBeInTheDocument()
    expect(await screen.findByText(/Otro equipo de la red/)).toBeInTheDocument()
  })

  it('the desktop app opens the wizard Nest step from «Cambiar de nido»', async () => {
    renderPage({ section: 'nido', surface: 'app' })
    await userEvent.click(await screen.findByRole('button', { name: 'Cambiar de nido' }))
    const wizard = await screen.findByRole('dialog', { name: 'Cambiar de nido' })
    expect(within(wizard).getByRole('heading', { name: 'Elige tu nido' })).toBeInTheDocument()
    expect(within(wizard).getByLabelText('Enlace de configuración')).toBeInTheDocument()
  })
})
