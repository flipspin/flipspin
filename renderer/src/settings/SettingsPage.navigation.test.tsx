import { installTestClock, clockUser, waitForClock as waitFor } from '../test/test-clock'
import { act, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { openSettings } from '../shell/ServerBadge'
import { ME_NORMAL, nav, renderPage } from './page-test-support'

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


describe('SettingsPage', () => {
  it('opens computer storage from the Resumen index for a member', async () => {
    renderPage({ section: 'resumen', me: ME_NORMAL })
    const index = document.querySelector('.settings-index') as HTMLElement
    await user.click(within(index).getByRole('button', { name: 'Almacenamiento' }))
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Almacenamiento' }))).toBeInTheDocument()
    expect(document.querySelector('.settings')).toHaveAttribute('data-page', 'almacenamiento')
  })

  it('groups the owner menu and opens Análisis from Addons and preserves file writes', async () => {
    let written = false
    renderPage({ section: 'analisis', respond: r => {
      if (r.pathname === '/api/config/analysis-tags') {
        if (r.method === 'PUT') written = (r.body as { write_analysis_tags: boolean }).write_analysis_tags
        return { status: 200, json: { write_analysis_tags: written } }
      }
      return undefined
    } })
    await waitFor(() => within(nav()).getByRole('button', { name: 'Cuentas' }))
    const names = within(nav()).getAllByRole('button').filter(el => !el.hasAttribute('aria-expanded')).map(el => el.textContent)
    expect(names).toEqual(['Resumen', 'Biblioteca', 'Rendimiento', 'Red', 'Seguridad', 'Motores', 'Sincronía de la letra', 'Stems', 'Análisis', 'Fuentes', 'Plugins', 'Equipos auxiliares', 'Cuentas', 'Acceso remoto', 'Mi cuenta', 'Mis dispositivos', 'General', 'Almacenamiento', 'Estado', 'Registro'])
    expect(Array.from(nav().querySelectorAll('.settings-nav__group'), el => el.textContent)).toEqual(['Nido', 'Funciones', 'Acceso', 'Este equipo', 'Sistema'])
    const analysis = screen.getByRole('region', { name: 'Análisis' })
    const toggle = await waitFor(() => within(analysis).getByRole('switch', { name: 'Guardar BPM y tono en los archivos' }))
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)
    await waitFor(() => expect(written).toBe(true))
    expect(toggle).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'Deshacer' }))
    await waitFor(() => expect(written).toBe(false))
  })

  it('keeps every old id and LEGACY alias navigable through openSettings', async () => {
    renderPage({ navigation: true })
    for (const [raw, id] of [
      ['dispositivos','dispositivos'], ['aj-dispositivos','dispositivos'], ['#aj-dispositivos','dispositivos'],
      ['equipo','equipo'], ['general','equipo'], ['theme','equipo'], ['atajos','equipo'], ['shortcuts','equipo'],
      ['missing','missing'], ['duplicates','duplicates'], ['analisis','analisis'], ['analysis','analisis'], ['import','biblioteca'], ['importar','biblioteca'],
      ['letras','letras'], ['lyrics','letras'], ['letras-nido','letras'], ['lyrics-settings','letras'], ['stems','stems'], ['extensiones','plugins'],
      ['config','performance'], ['performance','performance'], ['network','network'], ['security','security'],
      ['servidor','nido'], ['server','nido'], ['version','nido'], ['casa','cuentas'], ['sources','fuentes'], ['logs','registro'],
    ]) {
      act(() => openSettings(raw))
      await waitFor(() => expect(document.querySelector('.settings')).toHaveAttribute('data-page', id))
      const current = within(nav()).getByRole('button', { current: 'page' })
      if (id === 'letras' || id === 'stems' || id === 'analisis') {
        expect(current).toHaveTextContent('Motores')
        expect(document.querySelector('.cx-crumb')).toHaveTextContent('Motores›')
      }
      if (id === 'biblioteca') expect(current).toHaveTextContent('Biblioteca')
    }
  }, 15000)

  it.each(['#/ajustes/config', '#/settings/config'])('opens saved %s on Performance', async hash => {
    const previous = window.location.hash
    try {
      window.history.replaceState(null, '', hash)
      renderPage()
      expect(await waitFor(() => screen.getByRole('heading', { level: 2, name: 'Rendimiento' }))).toBeInTheDocument()
      expect(document.querySelector('.settings')).toHaveAttribute('data-page', 'performance')
      expect(await waitFor(() => within(nav()).getByRole('button', { current: 'page' }))).toHaveTextContent('Rendimiento')
    } finally {
      window.history.replaceState(null, '', previous || window.location.pathname)
    }
  })

  it('places Sources under Features and the server rows under Nest in the menu and overview', async () => {
    renderPage()
    const nest = (await waitFor(() => within(nav()).getByText('Nido'))).closest('.settings-nav__scope') as HTMLElement
    expect(within(nest).getAllByRole('button').filter(el => !el.hasAttribute('aria-expanded')).map(row => row.textContent)).toEqual([
      'Biblioteca', 'Rendimiento', 'Red', 'Seguridad',
    ])
    const index = document.querySelector('.settings-index') as HTMLElement
    const nestIndex = within(index).getByText('Nido').closest('.settings-index__group') as HTMLElement
    for (const name of ['Rendimiento', 'Red', 'Seguridad']) {
      expect(within(nestIndex).getByRole('button', { name })).toBeInTheDocument()
    }
    expect(within(nav()).queryByRole('button', { name: 'Avanzado' })).not.toBeInTheDocument()
  })

  it('openSettings(fuentes) navigates to the Fuentes page, including repeat and legacy requests', async () => {
    renderPage({ navigation: true })
    expect(screen.queryByRole('heading', { name: 'Fuentes' })).not.toBeInTheDocument()
    act(() => openSettings('fuentes'))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Fuentes' })).toBeInTheDocument())
    expect(screen.queryByRole('dialog', { name: 'Ajustes' })).not.toBeInTheDocument()
    act(() => openSettings('nido'))
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Estado del nido' }))).toBeInTheDocument()
    act(() => openSettings('fuentes'))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Fuentes' })).toBeInTheDocument())
  })

  it.each([['stems', 'Stems'], ['equipos', 'Equipos'], ['letras-nido', 'Letras'], ['letras', 'Letras'], ['lyrics', 'Letras'], ['config', 'Rendimiento'], ['performance', 'Rendimiento'], ['network', 'Red'], ['security', 'Seguridad']])('keeps %s behind the same admin gate as Lyrics', async (section, name) => {
    renderPage({ section, me: ME_NORMAL })
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Resumen' }))).toBeInTheDocument()
    expect(within(nav()).queryByRole('button', { name })).not.toBeInTheDocument()
    expect(screen.queryByText('Próximamente')).not.toBeInTheDocument()
  })

  it('opens Resumen as a page with the menu and no modal shell', async () => {
    renderPage()
    expect(await waitFor(() => screen.getByRole('heading', { level: 2, name: 'Resumen' }))).toBeInTheDocument()
    expect(within(nav()).getByRole('button', { name: /Resumen/ })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cerrar' })).not.toBeInTheDocument()
  })

  it('leaves the app background interactive and Escape keeps the page open', async () => {
    const { container } = renderPage()
    await user.keyboard('{Escape}')
    expect(container.inert).toBeFalsy()
    expect(document.body.style.overflow).not.toBe('hidden')
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Resumen' }))).toBeInTheDocument()
  })

  it('closes a section dialog on Escape while its page remains mounted', async () => {
    renderPage({ section: 'dispositivos' })
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Vincular dispositivo' })))
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Mis dispositivos' })).toBeInTheDocument()
  })

  it('keeps a section open on Escape after navigating from the index', async () => {
    renderPage()
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: /General/ }))
    await user.keyboard('{Escape}')
    expect(await waitFor(() => screen.getByRole('heading', { level: 2, name: /General/ }))).toBeInTheDocument()
  })

  it('moves between sections from the menu and from the index', async () => {
    renderPage()
    await user.click(within(nav()).getByRole('button', { name: /Mi cuenta/ }))
    expect(await waitFor(() => screen.getByRole('heading', { level: 2, name: /Mi cuenta/ }))).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Dispositivos' })).not.toBeInTheDocument()
    await user.click(within(nav()).getByRole('button', { name: 'Mis dispositivos' }))
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Dispositivos' }))).toBeInTheDocument()
    await user.click(within(nav()).getByRole('button', { name: /Resumen/ }))
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: /Biblioteca/ }))
    expect(await waitFor(() => screen.getByRole('heading', { level: 2, name: /Biblioteca/ }))).toBeInTheDocument()
  })

  it('understands the old modal’s section ids', async () => {
    renderPage({ section: 'nido' })
    expect(await waitFor(() => screen.getByRole('heading', { level: 2, name: /Estado del nido/ }))).toBeInTheDocument()
  })

  it('shows the admin sections to an admin only', async () => {
    renderPage({ me: ME_NORMAL, section: 'registro' })
    expect(await waitFor(() => screen.getByRole('heading', { level: 2, name: 'Resumen' }))).toBeInTheDocument()
    await waitFor(() => expect(within(nav()).queryByRole('button', { name: /Cuentas/ })).not.toBeInTheDocument())
    expect(within(nav()).getByRole('button', { name: /Acceso remoto/ })).toBeInTheDocument()
    expect(within(nav()).queryByRole('button', { name: /Registro/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Pendiente')).not.toBeInTheDocument()
  })

  it('an admin sees every section and the disk at the menu foot', async () => {
    renderPage()
    expect(await waitFor(() => within(nav()).getByRole('button', { name: /Cuentas/ }))).toBeInTheDocument()
    for (const name of ['Motores', 'General', 'Biblioteca', 'Fuentes', 'Registro']) {
      expect(within(nav()).getByRole('button', { name })).toBeInTheDocument()
    }
    expect(await waitFor(() => within(nav()).getByText('Flipspin 2,3 GB · 29,6 GB libres'))).toBeInTheDocument()
    expect(within(nav()).getByTitle('Disco del nido: 29,6 GB libres de 32 GB')).toBeInTheDocument()
    expect(within(nav()).getByText('v2.1.2')).toBeInTheDocument()
  })
})

it('shows menu B to members with exactly their existing sections', async () => {
  renderPage({ me: ME_NORMAL })
  await waitFor(() => within(nav()).getByRole('button', { name: 'Mi cuenta' }))
  expect(within(nav()).getAllByRole('button').filter(el => !el.hasAttribute('aria-expanded')).map(button => button.textContent)).toEqual([
    'Resumen', 'Motores', 'Plugins', 'Acceso remoto', 'Mi cuenta', 'Mis dispositivos', 'General', 'Almacenamiento', 'Estado',
  ])
  expect(within(nav()).queryByRole('button', { name: 'Letras' })).not.toBeInTheDocument()
  expect(Array.from(nav().querySelectorAll('.settings-nav__group'), group => group.textContent)).toEqual(['Funciones', 'Acceso', 'Este equipo', 'Sistema'])
})
