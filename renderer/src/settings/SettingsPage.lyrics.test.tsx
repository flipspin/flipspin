import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import i18n from '../i18n'
import { nav, renderPage } from './page-test-support'

describe('Lyrics settings and add-on', () => {
  it.each(['es', 'en'])('owns catalog coverage and controls without add-on copy in %s', async language => {
    await i18n.changeLanguage(language)
    let autoFetch = false
    let running = false
    const { fake } = renderPage({ section: 'letras-nido', respond: r => {
      if (r.pathname === '/api/lyrics/config' && r.method === 'PUT') {
        autoFetch = (r.body as { autoFetch: boolean }).autoFetch
        return { status: 200, json: { autoFetch } }
      }
      if (r.pathname === '/api/lyrics/scan' && r.method === 'POST') {
        running = true
        return { status: 200, json: { started: true, progressId: 'catalog-pass' } }
      }
      if (r.pathname === '/api/lyrics/jobs') return { status: 200, json: { autoFetch, withLyrics: 200, pendingCount: 14, running: running ? { done: 3, total: 40 } : null } }
      return undefined
    } })
    const main = screen.getByRole('main')
    const search = await within(main).findByRole('button', { name: language === 'es' ? 'Buscar ahora' : 'Search now' })
    await waitFor(() => expect(main.querySelector('.settings-legend')).toHaveTextContent('200'))
    const counts = main.querySelector('.settings-legend')!
    expect(counts).toHaveTextContent('14')
    expect(counts).toHaveTextContent('40')
    const toggle = within(main).getByRole('switch', { name: language === 'es' ? 'Al agregar canciones' : 'When songs are added' })
    expect(toggle).not.toBeChecked()
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle).toBeChecked())
    expect(fake.requests.find(r => r.pathname === '/api/lyrics/config' && r.method === 'PUT')?.body).toEqual({ autoFetch: true })
    await userEvent.click(search)
    await waitFor(() => expect(search).toBeDisabled())
    expect(main).toHaveTextContent(language === 'es' ? 'buscando · 3 de 40' : 'searching · 3 of 40')
    expect(fake.requests.find(r => r.pathname === '/api/lyrics/scan' && r.method === 'POST')?.body).toEqual({ tracks: [] })
    expect(within(main).queryByText('Motores en este equipo')).not.toBeInTheDocument()
    expect(within(main).getByRole('heading', { name: i18n.t("Sync jobs") })).toBeVisible()
    expect(fake.invocations.some(i => i.channel.startsWith('lyrics:engine'))).toBe(false)
  })

  it.each(['letras', 'lyrics'])('merges catalogue search and sync jobs on %s', async section => {
    renderPage({ section, respond: r => {
      if (r.pathname === '/api/lyrics/jobs') return { status: 200, json: { autoFetch: false, withLyrics: 200, pendingCount: 14, engine: { mode: 'agent', helpers: [] } } }
      if (r.pathname === '/api/jobs') return { status: 200, json: { jobs: [
        { id: 'sync-job', kind: 'lyrics-helper', label: 'Sync fixture', state: 'running', total: 4, succeeded: 1, failed: 0, skipped: 0, item: 'Song fixture', phase: 'alineando' },
        { id: 'catalog-job', kind: 'lyrics-search', label: 'Catalog fixture', state: 'running' },
        { id: 'stems-job', kind: 'stems', label: 'Stems fixture', state: 'running' },
      ], degraded: [] } }
      return undefined
    } })
    const main = screen.getByRole('main')
    expect(await within(main).findByRole('heading', { name: 'Trabajos de sincronización' })).toBeVisible()
    expect(await within(main).findByText('Sync fixture')).toBeVisible()
    expect(main).toHaveTextContent('sincronizando')
    expect(main).toHaveTextContent('1 / 4')
    expect(main).not.toHaveTextContent(/Catalog fixture|Stems fixture|Motores en este equipo/)
    expect(main).toHaveTextContent('Catálogos')
    expect(within(main).getByRole('button', { name: 'Buscar ahora' })).toBeVisible()
    expect(within(main).getByRole('switch', { name: 'Al agregar canciones' })).toBeVisible()
    expect(main.querySelector('.settings-legend')).not.toBeNull()
    expect(document.querySelector('.settings')).toHaveAttribute('data-page', 'letras')
    expect(within(nav()).getByRole('button', { current: 'page' })).toHaveTextContent('Motores')
  })
})

describe('fundamentals fixes', () => {
  it('lyrics missing counters show a dash with a reason, never NaN sin buscar', async () => {
    renderPage({ section: 'letras-nido', respond: r => r.pathname === '/api/lyrics/jobs' ? { status: 200, json: { autoFetch: false } } : undefined })
    expect(await screen.findByText('Catálogos')).toBeInTheDocument()
    const main = screen.getByRole('main')
    expect(main).not.toHaveTextContent('NaN')
    expect(within(main).getAllByTitle('El nido no envió los datos para calcularlo.').length).toBeGreaterThan(0)
  })

  it('lyrics counts subtract covered and pending songs when all numbers exist', async () => {
    renderPage({ section: 'letras-nido', respond: r => r.pathname === '/api/lyrics/jobs' ? { status: 200, json: { autoFetch: false, withLyrics: 200, pendingCount: 14 } } : undefined })
    await screen.findByText('Catálogos')
    expect(screen.getByText('por buscar').parentElement).toHaveTextContent('40 por buscar')
  })
})

describe('unavailable lyrics numbers', () => {
  it.each([null, -1, Number.POSITIVE_INFINITY])('does not compute coverage from an invalid counter: %s', async withLyrics => {
    renderPage({ section: 'letras-nido', respond: r => r.pathname === '/api/lyrics/jobs' ? { status: 200, json: { autoFetch: false, withLyrics, pendingCount: 14 } } : undefined })
    await screen.findByText('Catálogos')
    const count = screen.getByText('Por buscar', { selector: '.settings-job__counts > span' })
    expect(count).not.toHaveTextContent('—')
    expect(count).toHaveAttribute('title', 'El nido no envió los datos para calcularlo.')
    expect(screen.getByRole('main')).not.toHaveTextContent(/NaN|Infinity/)
  })

  it('shows unknown with a reason when the library total is absent', async () => {
    renderPage({ section: 'letras-nido', respond: r => {
      if (r.pathname === '/api/lyrics/jobs') return { status: 200, json: { autoFetch: false, withLyrics: 200, pendingCount: 14 } }
      if (r.pathname === '/api/library/summary') return { status: 200, json: { folder: '/m', albums: 1, artists: 1 } }
      return undefined
    } })
    await screen.findByText('Catálogos')
    const count = screen.getByText('Por buscar', { selector: '.settings-job__counts > span' })
    expect(count).not.toHaveTextContent('—')
    expect(count).toHaveAttribute('title', 'El nido no envió los datos para calcularlo.')
  })
})
