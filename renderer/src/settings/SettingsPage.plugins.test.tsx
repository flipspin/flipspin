import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { openSettings } from '../shell/ServerBadge'
import { ME_NORMAL, fakePlugin, nav, renderPage } from './page-test-support'

describe('SettingsPage', () => {
  it('renders a fake registry card under Plugins; Abrir reaches its lazy settings, Cerrar closes, Ir opens its page', async () => {
    const card = fakePlugin()
    const openPage = vi.fn()
    renderPage({ section: 'plugins', host: { openPage } })
    await within(nav()).findByRole('button', { name: 'Biblioteca' }, { timeout: 4000 })
    expect(Array.from(document.querySelectorAll('.cx-card'), card => card.getAttribute('aria-label'))).toEqual(['Ties', 'Recomendaciones', card.name])
    expect(screen.getByRole('region', { name: card.name })).not.toHaveClass('cx-card--accent')
    const region = within(screen.getByRole('region', { name: card.name }))
    expect(region.getByText('Extensión')).toBeVisible()
    expect(region.getByText(card.nido.value)).toBeVisible()
    expect(region.getByText(card.computer.value)).toBeVisible()
    await userEvent.click(region.getByRole('button', { name: 'Instalar' }))
    await userEvent.click(region.getByRole('button', { name: 'Quitar' }))
    expect(card.computer.install!.run).toHaveBeenCalledOnce()
    expect(card.computer.remove!.run).toHaveBeenCalledOnce()
    await userEvent.click(region.getByRole('button', { name: 'Abrir' }))
    // Loading the plugin's lazy module is independent of the navigation query.
    expect(await region.findByText('Ajustes del complemento', {}, { timeout: 4000 })).toBeVisible()
    await userEvent.click(region.getByRole('button', { name: 'Ir' }))
    expect(openPage).toHaveBeenCalledWith('example-settings')
    await userEvent.click(region.getByRole('button', { name: 'Cerrar' }))
    expect(region.queryByText('Ajustes del complemento')).not.toBeInTheDocument()
  })

  it('a card can open its page directly and old plugin ids land on Plugins', async () => {
    const card = fakePlugin()
    card.open = { kind: 'page', id: 'example-settings' }
    const openPage = vi.fn()
    renderPage({ navigation: true, host: { openPage } })
    for (const id of ['extensiones', card.id, 'example-settings']) {
      act(() => openSettings(id))
      await waitFor(() => expect(document.querySelector('.settings')).toHaveAttribute('data-page', 'plugins'))
      await within(nav()).findByRole('button', { name: 'Biblioteca' }, { timeout: 4000 })
      expect(within(nav()).getByRole('button', { current: 'page' })).toHaveTextContent('Plugins')
    }
    await userEvent.click(within(screen.getByRole('region', { name: card.name })).getByRole('button', { name: 'Abrir' }))
    expect(openPage).toHaveBeenCalledWith('example-settings')
  })

  it.each(['settings', 'page'] as const)('disables Abrir for a missing %s target', async kind => {
    const card = fakePlugin()
    card.open = { kind, id: 'missing-target' }
    renderPage({ section: 'plugins', host: { openPage: vi.fn() } })
    await within(nav()).findByRole('button', { name: 'Biblioteca' }, { timeout: 4000 })
    const open = within(screen.getByRole('region', { name: card.name })).getByRole('button', { name: 'Abrir' })
    expect(open).toBeDisabled()
    expect(open).not.toHaveAttribute('title', 'Solo admin')
  })

  it('honors disabled plugin actions and an unavailable page host', async () => {
    const card = fakePlugin()
    card.open = { kind: 'page', id: 'example-settings' }
    card.computer.install!.disabled = true
    card.computer.remove!.disabled = true
    renderPage({ section: 'plugins' })
    await within(nav()).findByRole('button', { name: 'Biblioteca' }, { timeout: 4000 })
    const region = within(screen.getByRole('region', { name: card.name }))
    expect(region.getByRole('button', { name: 'Abrir' })).toBeDisabled()
    await userEvent.click(region.getByRole('button', { name: 'Instalar' }))
    await userEvent.click(region.getByRole('button', { name: 'Quitar' }))
    expect(card.computer.install!.run).not.toHaveBeenCalled()
    expect(card.computer.remove!.run).not.toHaveBeenCalled()
  })

  it('keeps plugin settings and local actions unavailable to members', async () => {
    const card = fakePlugin()
    renderPage({ section: 'plugins', me: ME_NORMAL })
    const region = within(await screen.findByRole('region', { name: card.name }))
    expect(region.getByRole('button', { name: 'Abrir' })).toBeDisabled()
    expect(region.queryByRole('button', { name: 'Instalar' })).not.toBeInTheDocument()
    expect(region.queryByRole('button', { name: 'Quitar' })).not.toBeInTheDocument()
    expect(region.queryByText('Ajustes del complemento')).not.toBeInTheDocument()
  })
})

it.each([['Letras', 'letras'], ['Stems', 'stems'], ['Análisis', 'analisis']])('opens %s from its Engines card', async (name, id) => {
  renderPage({ section: 'complementos' })
  await within(nav()).findByRole('button', { name: 'Cuentas' })
  const card = screen.getByRole('region', { name })
  await userEvent.click(within(card).getByRole('button', { name: 'Abrir' }))
  expect(document.querySelector('.settings')).toHaveAttribute('data-page', id)
  expect(within(nav()).getByRole('button', { current: 'page' })).toHaveTextContent('Motores')
  expect(screen.getByRole('main').querySelector('.cx-crumb')).toHaveTextContent('Motores')
})
