import { installTestClock, clockUser, waitForClock as waitFor } from '../test/test-clock'
import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../data'
import { ME_NORMAL, fake, nav, renderPage } from './page-test-support'

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


const UPDATE = {
  checking: true, current: '2.1.2', latest: '2.2.0', updateAvailable: true,
  releaseUrl: 'https://github.com/flipspin/flipspin/releases/tag/v2.2.0', install: 'script', pinned: false,
  command: 'krobi update', checkedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), lastError: null,
}

describe('owner update notice', () => {
  it('opens and focuses the version card from the account menu destination', async () => {
    renderPage({ section: 'version', respond: r => r.pathname === '/api/server/update' ? { status: 200, json: UPDATE } : undefined })
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Estado del nido' }))).toBeInTheDocument()
    await waitFor(() => expect(document.getElementById('aj-version')).toHaveFocus())
    expect(await waitFor(() => screen.getByRole('button', { name: 'Omitir esta versión' }))).toBeInTheDocument()
  })

  it('skips and restores the version on the server and refreshes attention', async () => {
    let skipped: string | null = null
    const { client, fake } = renderPage({ section: 'nido', respond: r => {
      if (r.pathname === '/api/server/update/skip') {
        skipped = r.method === 'PUT' ? '2.2.0' : null
        return { status: 200, json: { ...UPDATE, skipped } }
      }
      if (r.pathname === '/api/server/update') return { status: 200, json: { ...UPDATE, skipped } }
      return undefined
    } })
    client.setQueryData(queryKeys.me.attention(), { flag: 'version', flagTone: 'info' })
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Omitir esta versión' })))
    expect(await waitFor(() => screen.getByRole('button', { name: 'Volver a avisar' }))).toBeInTheDocument()
    expect(fake.requests.find(r => r.pathname.endsWith('/skip') && r.method === 'PUT')?.body).toEqual({ version: '2.2.0' })
    expect(client.getQueryState(queryKeys.me.attention())?.isInvalidated).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Volver a avisar' }))
    expect(await waitFor(() => screen.getByRole('button', { name: 'Omitir esta versión' }))).toBeInTheDocument()
    expect(fake.requests.some(r => r.pathname.endsWith('/skip') && r.method === 'DELETE')).toBe(true)
  })

  const states = [
    { code: 'A', changes: {}, word: 'Actualización disponible', command: 'krobi update', behind: true },
    { code: 'B', changes: { install: 'compose', command: 'docker compose pull && docker compose up -d' }, word: 'Actualización disponible', command: 'docker compose pull && docker compose up -d', behind: true },
    { code: 'C', changes: { install: 'unraid', command: null }, word: 'Actualización disponible', how: 'Desde Docker en Unraid', behind: true },
    { code: 'D', changes: { pinned: true, command: null }, word: 'Actualización disponible', how: 'Versión fijada', behind: true },
    { code: 'E', changes: { lastError: 'unreachable' }, word: 'Actualización disponible', command: 'krobi update', behind: true },
    { code: 'F', changes: { latest: '2.1.2', updateAvailable: false }, word: 'Actualizado', behind: false },
    { code: 'G', changes: { checking: false, updateAvailable: true }, word: 'Búsqueda desactivada', behind: false },
    { code: 'H', changes: { latest: null, releaseUrl: null, lastError: 'no-release', updateAvailable: false }, word: 'Sin versiones publicadas', behind: false },
    { code: 'I', changes: { latest: null, releaseUrl: null, checkedAt: null, updateAvailable: false }, word: 'Buscando', behind: false },
  ]
  it.each(states)('matches canvas state $code across Resumen, nav and Versión', async state => {
    const body = { ...UPDATE, ...state.changes }
    const { client } = renderPage({ respond: r => r.pathname === '/api/server/update' ? { status: 200, json: body } : undefined })
    await waitFor(() => screen.getByRole('heading', { name: 'Resumen' }))
    await waitFor(() => expect(client.getQueryData(queryKeys.server.update())).toEqual(body))
    if (state.behind) {
      const row = await waitFor(() => screen.getByRole('button', { name: /Nueva versión de Flipspin/ }))
      expect(row).toHaveTextContent('2.1.2 → 2.2.0')
      expect(within(nav()).getByRole('button', { name: '→ 2.2.0' })).toBeInTheDocument()
      await user.click(row)
    } else {
      expect(screen.queryByRole('button', { name: /Nueva versión de Flipspin/ })).not.toBeInTheDocument()
      await user.click(within(nav()).getByRole('button', { name: 'Estado' }))
      expect(screen.queryByRole('button', { name: /Nueva versión de Flipspin/ })).not.toBeInTheDocument()
      expect(within(nav()).queryByText('→ 2.2.0')).not.toBeInTheDocument()
    }
    expect(await waitFor(() => screen.getByText(new RegExp(state.word, 'i')))).toBeInTheDocument()
    expect(screen.getByTitle('La versión más reciente publicada de Flipspin')).toHaveTextContent('Versión')
    expect(screen.getByText('Actualizar')).toBeInTheDocument()
    expect(screen.queryByText('Más reciente')).not.toBeInTheDocument()
    if (['G', 'H', 'I'].includes(state.code)) expect(screen.getByTitle('La versión más reciente publicada de Flipspin').parentElement?.parentElement).not.toHaveTextContent('—')
    expect(screen.queryByRole('link', { name: 'Novedades' }) !== null).toBe(state.behind)
    expect(screen.queryByRole('button', { name: 'Copiar' }) !== null).toBe(!!state.command)
    if (state.command) expect(screen.getByText(state.command)).toBeInTheDocument()
    if (state.how) expect(screen.getByText(state.how, { exact: false })).toHaveAttribute('title')
    if (state.code === 'E') expect(screen.getByText('GitHub no respondió', { exact: false })).toHaveAttribute('title', 'Se volverá a intentar solo')
    if (state.code === 'I') expect(screen.getByText('todavía no')).toBeInTheDocument()
    if (state.code === 'G') {
      expect(screen.queryByText('Última búsqueda')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Buscar ahora' })).not.toBeInTheDocument()
      await user.click(screen.getByRole('button', { name: 'Red ›' }))
      expect(await waitFor(() => screen.getByRole('heading', { level: 2, name: 'Red' }))).toBeInTheDocument()
      expect(document.querySelector('.settings')).toHaveAttribute('data-page', 'network')
    } else expect(screen.getByRole('button', { name: 'Buscar ahora' })).toHaveAttribute('title', 'Máximo una vez cada 5 minutos')
  })

  it('nav mark opens Estado, copies verbatim, opens release, and manually checks', async () => {
    const user = clockUser()
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText')
    renderPage({ respond: r => r.pathname === '/api/server/update' || r.pathname === '/api/server/update/check' ? { status: r.method === 'POST' ? 202 : 200, json: UPDATE } : undefined })
    await user.click(await waitFor(() => screen.getByRole('button', { name: '→ 2.2.0' })))
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Copiar' })))
    expect(clipboard).toHaveBeenCalledWith('krobi update')
    expect(await waitFor(() => screen.getByText('Comando copiado'))).toBeInTheDocument()
    await user.click(screen.getByRole('link', { name: 'Novedades' }))
    expect(open).toHaveBeenCalledWith(UPDATE.releaseUrl, '_blank', 'noopener,noreferrer')
    await user.click(screen.getByRole('button', { name: 'Buscar ahora' }))
    await waitFor(() => expect(fake!.requests.some(r => r.pathname === '/api/server/update/check' && r.method === 'POST')).toBe(true))
    open.mockRestore()
  })

  it.each([{ status: 403, section: 'resumen' }, { status: 403, section: 'nido' }, { status: 404, section: 'resumen' }, { status: 404, section: 'nido' }])('renders no update additions on $status in $section', async ({ status, section }) => {
    const { client } = renderPage({ section, respond: r => r.pathname === '/api/server/update' ? { status, json: { detail: status === 404 ? 'Not Found' : 'Forbidden' } } : undefined })
    await waitFor(() => expect(client.getQueryState(queryKeys.server.update())?.status).toBe('error'))
    expect(screen.queryByRole('button', { name: /Nueva versión de Flipspin/ })).not.toBeInTheDocument()
    expect(screen.queryByText('Más reciente')).not.toBeInTheDocument()
    expect(screen.queryByText('Instalación')).not.toBeInTheDocument()
    expect(screen.queryByText('→ 2.2.0')).not.toBeInTheDocument()
  })

  it.each(['resumen', 'nido'])('members retain today’s %s and never request update facts', async section => {
    renderPage({ section, me: ME_NORMAL, respond: r => r.pathname === '/api/server/update' ? { status: 200, json: UPDATE } : undefined })
    await waitFor(() => screen.getByRole('heading', { name: section === 'nido' ? 'Estado del nido' : 'Resumen' }))
    expect(screen.queryByText('Más reciente')).not.toBeInTheDocument()
    expect(screen.queryByText('Nueva versión de Flipspin')).not.toBeInTheDocument()
    expect(screen.queryByText('→ 2.2.0')).not.toBeInTheDocument()
    expect(fake!.requests.some(r => r.pathname === '/api/server/update')).toBe(false)
  })
})
