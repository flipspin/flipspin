import { clockUser, installTestClock, waitForClock as waitFor } from '../test/test-clock'

import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { ME_NORMAL, fake, nav, renderPage } from './page-test-support'
import { type RecordedRequest, type ResponseSpec } from './test-support'

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


describe('SettingsPage', () => {
  it('«Library»: the folder as a job, the disk split', async () => {
    renderPage({ section: 'biblioteca' })
    expect(await waitFor(() => screen.getByText('/music'))).toBeInTheDocument()
    expect(screen.getByText(/180 álbumes/)).toBeInTheDocument()
    expect(await waitFor(() => screen.getByText('1,9 GB'))).toBeInTheDocument()
    expect(screen.getByText('Stems', { selector: '.settings-tipped' })).toBeInTheDocument()
    expect(screen.getByText('Flipspin 2,3 GB')).toBeInTheDocument()
    expect(screen.getByText('Disco · 29,6 GB libres de 32 GB')).toBeInTheDocument()
    expect(screen.queryByText('Otros archivos')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Registros, caché, modelos y otros archivos.')).not.toBeInTheDocument()
  })

  it('«Library» on an older nest: a version note, not an error', async () => {
    renderPage({ section: 'biblioteca', respond: (r) => (r.pathname === '/api/server/storage' ? { status: 404, json: { detail: 'Not Found' } } : undefined) })
    expect(await waitFor(() => screen.getByText('Actualiza el nido para ver el almacenamiento.'))).toBeInTheDocument()
  })

  it('«Library» with an empty folder', async () => {
    renderPage({ section: 'biblioteca', respond: (r) => (r.pathname === '/api/library/summary' ? { status: 200, json: { folder: '/m', songs: 0, albums: 0, artists: 0 } } : undefined) })
    expect(await waitFor(() => screen.getByTitle('La carpeta está vacía.'))).toHaveTextContent('0 canciones')
  })

  it('«Library» error has «Reintentar»', async () => {
    renderPage({ section: 'biblioteca', respond: (r) => (r.pathname === '/api/library/summary' ? { status: 500, json: { detail: 'x' } } : undefined) })
    expect(await waitFor(() => screen.getByText('No se pudo cargar la biblioteca.'))).toBeInTheDocument()
  })
})

describe('fundamentals fixes', () => {
  it('empty sources explain why and offer the next step', async () => {
    renderPage({ section: 'fuentes', respond: r => r.pathname === '/api/providers' ? { status: 200, json: { providers: [] } } : undefined })
    expect(await waitFor(() => screen.getByText('El nido no tiene fuentes registradas.'))).toBeInTheDocument()
    expect(screen.getByText('El nido no tiene fuentes registradas.')).toHaveAttribute('title', 'El nido no cargó sus fuentes. Reinícialo y vuelve a intentarlo.')
    const before = fake!.requests.filter(r => r.pathname === '/api/providers').length
    await user.click(screen.getByRole('button', { name: 'Reintentar' }))
    await waitFor(() => expect(fake!.requests.filter(r => r.pathname === '/api/providers').length).toBeGreaterThan(before))
  })
})

describe('nested source card states', () => {
  it.each([['youtube', '/api/config/ytdlp-cookies']])('%s settings resolve old routes and offer retry on failure', async (id, route) => {
    let status = 404
    const respond = (r: RecordedRequest): ResponseSpec | undefined => {
      if (r.pathname === '/api/providers') return { status: 200, json: { providers: [{ id, name: id, kind: 'streaming', available: false, capabilities: [] }] } }
      if (r.pathname === route) return { status, json: { detail: status === 404 ? 'Not Found' : 'boom' } }
      return undefined
    }
    const view = renderPage({ section: 'fuentes', respond })
    await user.click(await waitFor(() => screen.getByRole('button', { name: `Abrir ${id}` })))
    expect((await waitFor(() => screen.getAllByText(/Actualiza el nido/))).length).toBeGreaterThan(0)
    expect(document.querySelector('.settings-main .settings-skel')).not.toBeInTheDocument()
    view.unmount(); fake?.restore()
    status = 500
    renderPage({ section: 'fuentes', respond })
    await user.click(await waitFor(() => screen.getByRole('button', { name: `Abrir ${id}` })))
    await waitFor(() => screen.getByRole('button', { name: 'Reintentar' }))
    expect(document.querySelector('.settings-main .settings-skel')).not.toBeInTheDocument()
  })
})

describe('library health navigation', () => {
  it.each([3, 0])('shows the Fix-now badge only for a positive count (%s)', async count => {
    const health = (await import('../../../contracts/wire/library-health.json')).default
    const data = structuredClone(health)
    data.checks.find(c => c.id === 'missing')!.count = count
    renderPage({ section: 'health', respond: r => r.pathname === '/api/library/health' ? { status: 200, json: data } : undefined })
    const item = await waitFor(() => within(nav()).getByRole('button', { name: /Salud de la biblioteca/ }))
    await waitFor(() => screen.getByRole('region', { name: count ? 'Resolver ahora' : 'Todo en orden' }))
    const badge = item.querySelector('.settings-nav__badge')
    if (count) {
      expect(badge).toHaveTextContent('3')
      expect(badge).toHaveAttribute('title', expect.stringContaining('missing-files.known'))
    } else expect(badge).toBeNull()
  })
})

it('opens Library health estimates directly in the Analysis review', async () => {
  renderPage({ section: 'estimates' })
  expect(await waitFor(() => screen.getByRole('heading', { name: 'Revisar estimados' }))).toBeInTheDocument()
  await user.click(await waitFor(() => within(screen.getByRole('main')).getByRole('button', { name: 'Análisis' })))
  expect(await waitFor(() => screen.getByRole('heading', { level: 2, name: 'Análisis' }))).toBeInTheDocument()
})

it('explains a member health deep link without fetching owner facts', async () => {
  const { fake } = renderPage({ section: 'health', me: ME_NORMAL })
  expect(await waitFor(() => screen.getByText('Sin acceso'))).toBeInTheDocument()
  expect(within(nav()).queryByRole('button', { name: 'Salud de la biblioteca' })).not.toBeInTheDocument()
  expect(fake.requests.filter(r => r.pathname === '/api/library/health')).toHaveLength(0)
})
