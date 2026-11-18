import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import { ME_NORMAL, fakePlugin, nav, renderPage } from './page-test-support'
import { settingsMenuKey } from './useSettingsMenu'

const arrow = (name: string) => within(nav()).getByRole('button', { name: `Mostrar u ocultar ${name}` })
const children = (button: HTMLElement) => document.getElementById(button.getAttribute('aria-controls')!)!
afterEach(() => vi.restoreAllMocks())

describe('nested settings menu', () => {
  it('toggles with keyboard and click, persists per viewer, and opens the current parent', async () => {
    const user = userEvent.setup()
    const view = renderPage({ section: 'analisis' })
    await within(nav()).findByRole('button', { name: 'Cuentas' })
    const engines = arrow('Motores')
    expect(engines).toHaveAttribute('aria-expanded', 'true')
    expect(within(children(engines)).getByRole('button', { name: 'Sincronía de la letra' })).toBeVisible()
    expect(children(engines).querySelector('svg')).toBeNull()
    engines.focus()
    await user.keyboard('{Enter}')
    expect(engines).toHaveAttribute('aria-expanded', 'false')
    expect(children(engines)).not.toBeVisible()
    await user.keyboard(' ')
    expect(engines).toHaveAttribute('aria-expanded', 'true')
    await user.click(engines)
    const sources = arrow('Fuentes')
    await user.click(sources)
    await user.click(arrow('Plugins'))
    const entry = settingsMenuKey('lib-1', 'u1')
    await waitFor(() => expect(JSON.parse(localStorage.getItem(entry)!)).toMatchObject({ complementos: false, fuentes: true, plugins: true }))
    view.unmount()
    const next = renderPage({ section: 'network' })
    await within(nav()).findByRole('button', { name: 'Cuentas' })
    expect(arrow('Motores')).toHaveAttribute('aria-expanded', 'false')
    expect(arrow('Fuentes')).toHaveAttribute('aria-expanded', 'true')
    expect(arrow('Plugins')).toHaveAttribute('aria-expanded', 'true')
    await user.click(within(nav()).getByRole('button', { name: 'Motores' }))
    expect(arrow('Motores')).toHaveAttribute('aria-expanded', 'true')
    await user.click(arrow('Motores'))
    await user.click(within(nav()).getByRole('button', { name: 'Motores' }))
    expect(arrow('Motores')).toHaveAttribute('aria-expanded', 'true')
    next.unmount()
    renderPage({ section: 'network', me: ME_NORMAL })
    await screen.findByRole('heading', { name: 'Resumen', level: 2 })
    expect(arrow('Plugins')).toHaveAttribute('aria-expanded', 'false')
    expect(settingsMenuKey('nest-a', 'u1')).not.toBe(settingsMenuKey('nest-b', 'u1'))
    expect(settingsMenuKey('nest-a', 'u1')).not.toBe(settingsMenuKey('nest-a', 'u2'))
  })

  it.each(['getItem', 'setItem'] as const)('renders and toggles when storage %s throws', async method => {
    const original = localStorage[method].bind(localStorage)
    vi.spyOn(localStorage, method).mockImplementation((...args: [string, string?]) => {
      if (args[0].startsWith('krobi.settings.menu.')) throw new Error('Storage unavailable')
      return original(...args as [string, string])
    })
    renderPage({ section: 'analisis' })
    await within(nav()).findByRole('button', { name: 'Cuentas' })
    await userEvent.click(arrow('Motores'))
    expect(arrow('Motores')).toHaveAttribute('aria-expanded', 'false')
    expect(await screen.findByRole('heading', { name: 'Análisis', level: 2 })).toBeVisible()
  })

  it('ignores malformed storage and keeps current sections open over a saved closed preference', async () => {
    const key = settingsMenuKey('lib-1', 'u1')
    localStorage.setItem(key, '{broken')
    const view = renderPage({ section: 'sources-audio' })
    await within(nav()).findByRole('button', { name: 'Cuentas' })
    expect(arrow('Fuentes')).toHaveAttribute('aria-expanded', 'true')
    view.unmount()
    localStorage.setItem(key, JSON.stringify({ fuentes: false }))
    renderPage({ section: 'sources-metadata' })
    await within(nav()).findByRole('button', { name: 'Cuentas' })
    expect(arrow('Fuentes')).toHaveAttribute('aria-expanded', 'true')
  })

  it('shows Sources groups from nested destinations and translates at render time', async () => {
    renderPage({ section: 'fuentes' })
    await within(nav()).findByRole('button', { name: 'Cuentas' })
    for (const [name, id] of [['Fuente de audio', 'sources-audio'], ['Metadatos', 'sources-metadata'], ['Letras', 'sources-lyrics']]) {
      await userEvent.click(within(children(arrow('Fuentes'))).getByRole('button', { name }))
      expect(document.querySelector('.settings')).toHaveAttribute('data-page', id)
      expect(await screen.findByRole('heading', { name, level: 2 })).toBeVisible()
      expect(within(nav()).getByRole('button', { current: 'page' })).toHaveTextContent('Fuentes')
    }
    await act(() => i18n.changeLanguage('en'))
    expect(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Show or hide Sources' })).toHaveAttribute('aria-expanded', 'true')
    expect(within(screen.getByRole('navigation', { name: 'Settings sections' })).getByRole('button', { name: 'Engines' })).toBeVisible()
  })

  it('opens loaded host cards and built-in plugin subsections under Plugins', async () => {
    const card = fakePlugin()
    renderPage({ section: 'plugins' })
    await within(nav()).findByRole('button', { name: 'Cuentas' })
    const branch = children(arrow('Plugins'))
    for (const name of ['Ties', 'Recomendaciones', card.name]) expect(within(branch).getByRole('button', { name })).toBeVisible()
    await userEvent.click(within(branch).getByRole('button', { name: 'Ties' }))
    expect(document.querySelector('.settings')).toHaveAttribute('data-page', 'ties')
    expect(screen.getByRole('main').querySelector('.cx-card[aria-label="Ties"]')).toBeVisible()
    await userEvent.click(within(branch).getByRole('button', { name: 'Recomendaciones' }))
    expect(document.querySelector('.settings')).toHaveAttribute('data-page', 'recommendations')
    await userEvent.click(within(branch).getByRole('button', { name: card.name }))
    const region = within(screen.getByRole('region', { name: card.name }))
    await userEvent.click(region.getByRole('button', { name: 'Abrir' }))
    expect(await region.findByText('Ajustes del complemento')).toBeVisible()
    expect(within(nav()).getByRole('button', { current: 'page' })).toHaveTextContent('Plugins')
    await userEvent.click(within(nav()).getByRole('button', { name: 'Motores' }))
    for (const name of ['Ties', 'Recomendaciones', card.name]) expect(screen.queryByRole('region', { name })).not.toBeInTheDocument()
  })

  it('uses the same disclosure structure for Library health', async () => {
    renderPage({ section: 'health' })
    await within(nav()).findByRole('button', { name: 'Cuentas' })
    expect(arrow('Biblioteca')).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(arrow('Biblioteca'))
    expect(within(nav()).queryByRole('button', { name: 'Salud de la biblioteca' })).not.toBeInTheDocument()
  })
})
