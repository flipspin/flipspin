import { clockUser, installTestClock, waitForClock as waitFor } from '../test/test-clock'

import { QueryClient } from '@tanstack/react-query'
import { act, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DataProvider } from '../data'
import { ConfigProvider } from './config'
import { SettingsProvider } from './context'
import { GB, HANDSHAKE, HOST, ME_NORMAL, ORIGIN, host, nav, renderPage, setPageFake } from './page-test-support'
import { ToastProvider } from './parts'
import { NestStatus } from './sections/NestStatus'
import { installFakeSettings, serverStatus } from './test-support'
import { setStreamState } from '../data/streamState'

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


describe('SettingsPage', () => {
  it('shows live updates and watch status on Status, with loss only in the menu foot', async () => {
    setStreamState({ state: 'connected', since: Date.now() })
    renderPage({ section: 'nido', respond: r => r.pathname === '/api/library/scan' ? { status: 200, json: {
      watching: true, intervalSeconds: 1800, scanning: false, pending: false, lastScanAt: null, durationSeconds: null, error: null,
    } } : undefined })
    expect(await waitFor(() => screen.getByText('Vigilando'))).toBeVisible()
    expect(screen.getByText('comprobación completa cada 30 min')).toBeVisible()
    expect(screen.getByText('Actualizaciones en directo')).toBeVisible()
    expect(within(nav()).queryByText('Se perdieron las actualizaciones en directo')).not.toBeInTheDocument()
    act(() => setStreamState({ state: 'lost', since: Date.now() - 2000 }))
    const lost = await waitFor(() => within(nav()).getByText('Se perdieron las actualizaciones en directo'))
    expect(lost.closest('.settings-nav__foot')).not.toBeNull()
    expect(screen.getByText('Reconectando')).toBeVisible()
    act(() => setStreamState({ state: 'connected', since: Date.now() }))
    expect(within(nav()).queryByText('Se perdieron las actualizaciones en directo')).not.toBeInTheDocument()
  })

  it('Estado shows the host facts and moves Dónde corre out of Versión', async () => {
    renderPage({ section: 'nido' })
    const block = await waitFor(() => screen.getByRole('region', { name: 'Equipo' }))
    expect(await waitFor(() => within(block).getByText('krobi'))).toBeInTheDocument()
    expect(block).toHaveTextContent('Debian 12 · Linux 7.0 · x86_64')
    expect(block).toHaveTextContent('Contenedor LXC · Proxmox')
    expect(within(block).getByTitle(/Intel Core i7-8750H · 4 núcleos/)).toBeInTheDocument()
    expect(block).toHaveTextContent('0.1 de 4 GB')
    expect(within(block).getByTitle(/hace 3 semanas/)).toBeInTheDocument()
    expect(within(block).getByTitle(/En otro equipo de tu casa · este equipo es x86/)).toBeInTheDocument()
    expect(block.querySelectorAll('.settings-kv > div')).toHaveLength(3)
    expect(within(block).getByRole('meter', { name: 'Memoria' })).toHaveAttribute('aria-valuenow', '122683392')
    const version = screen.getByRole('heading', { name: 'Versión' }).closest('.settings-block')!
    expect(version).not.toHaveTextContent('Dónde está')
    expect(version).toHaveTextContent('Tiempo encendidohace 9 min')
  })

  it('Estado never requests the host for a member, even when mounted directly', async () => {
    const fake = setPageFake(installFakeSettings({ probe: () => ({ ok: true, url: ORIGIN, handshake: HANDSHAKE }), respond: r => r.pathname === '/api/status' ? { status: 200, json: HANDSHAKE } : undefined }))
    render(<DataProvider queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SettingsProvider value={{ surface: 'dev', admin: false, me: { ...ME_NORMAL, onboarded: true }, meStatus: null, mePending: false, meError: null,
        refreshMe: vi.fn(), server: { kind: 'ready', value: serverStatus() }, refreshServer: vi.fn(), host: host(), go: vi.fn() }}>
        <ToastProvider><ConfigProvider><NestStatus /></ConfigProvider></ToastProvider>
      </SettingsProvider>
    </DataProvider>)
    await waitFor(() => screen.getByText('2.1.2'))
    expect(screen.queryByRole('region', { name: 'Equipo' })).not.toBeInTheDocument()
    expect(fake.requests.some(r => r.pathname === '/api/server/host')).toBe(false)
  })

  it('Estado shows unknown facts as a word with a reason, never a bare dash', async () => {
    const empty = Object.fromEntries(Object.keys(HOST).map(key => [key, null]))
    renderPage({ section: 'nido', respond: r => r.pathname === '/api/server/host' ? { status: 200, json: empty } : undefined })
    const block = await waitFor(() => screen.getByRole('region', { name: 'Equipo' }))
    const unknown = await waitFor(() => within(block).getAllByTitle('El nido no pudo leer este dato de su sistema.'))
    expect(unknown.length).toBe(3)
    expect(unknown.every(node => node.textContent?.startsWith('No disponible'))).toBe(true)
    expect(within(block).queryByRole('meter')).not.toBeInTheDocument()
  })

  it('Estado loads host rows, retries failures, and shows local engine without the agent dot', async () => {
    let failed = true
    renderPage({ section: 'nido', respond: r => r.pathname === '/api/server/host'
      ? failed ? { status: 500, json: { detail: 'unavailable' } } : { status: 200, json: { ...HOST, engine: 'local', isolation: 'none' } }
      : undefined })
    await waitFor(() => screen.getByRole('status', { name: 'Cargando el equipo' }))
    const block = await waitFor(() => screen.getByRole('region', { name: 'Equipo' }))
    const retry = await waitFor(() => within(block).getByRole('button', { name: 'Reintentar' }))
    failed = false
    await user.click(retry)
    expect(await waitFor(() => within(block).getByTitle(/Letras y pistas: En este equipo/))).toBeInTheDocument()
    expect(block).not.toHaveTextContent('Ninguno')
    expect(block.querySelector('.settings-host-info')).toBeNull()
  })

  it('draws the nest on «Resumen» from the handshake and the storage route', async () => {
    renderPage()
    expect(await waitFor(() => screen.getByText('Nido de krobi'))).toBeInTheDocument()
    expect(await waitFor(() => screen.getByText('Flipspin 2,3 GB · Disco 29,6 GB libres de 32 GB'))).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Flipspin 2,3 GB · Disco 29,6 GB libres de 32 GB' })).toBeInTheDocument()
    expect(await waitFor(() => screen.getByText('254 canciones'))).toBeInTheDocument()
    expect(await waitFor(() => screen.getByText('2 cuentas · 1 admin'))).toBeInTheDocument()
  })

  it('keeps Flipspin size separate from shared-disk usage in the nest and menu foot', async () => {
    renderPage({ respond: r => r.pathname === '/api/server/storage' ? {
      status: 200,
      json: { disk: { total: 983 * GB, free: 921 * GB }, music: 2.8 * GB, stems: 0.45 * GB, other: 58.75 * GB },
    } : undefined })
    expect(await waitFor(() => within(nav()).getByText('Flipspin 3,3 GB · 921 GB libres'))).toBeInTheDocument()
    const meter = within(nav()).getByTitle('Disco del nido: 921 GB libres de 983 GB')
    expect(Number.parseFloat((meter.firstElementChild as HTMLElement).style.width)).toBeCloseTo((1 - 921 / 983) * 100)
    expect(await waitFor(() => screen.getByText('Flipspin 3,3 GB · Disco 921 GB libres de 983 GB'))).toBeInTheDocument()
    const bar = screen.getByRole('img', { name: 'Flipspin 3,3 GB · Disco 921 GB libres de 983 GB' })
    expect(bar.children).toHaveLength(3)
    expect(Number.parseFloat(within(bar).getByTitle('Música · 2,8 GB').style.width)).toBeCloseTo(2.8 / 983 * 100)
    expect(Number.parseFloat(within(bar).getByTitle('Stems · 450 MB').style.width)).toBeCloseTo(0.45 / 983 * 100)
    const other = within(bar).getByTitle('En uso por otros programas o el sistema')
    expect(Number.parseFloat(other.style.width)).toBeCloseTo(58.75 / 983 * 100)
    expect(other.style.getPropertyValue('--_c')).toBe('var(--color-text-tertiary)')
    expect(screen.queryByText('Otros archivos')).not.toBeInTheDocument()
  })

  it('«Resumen» while the nest is being asked: a skeleton, then the answer', async () => {
    renderPage()
    expect(screen.getByRole('status', { name: 'Cargando el estado del nido' })).toBeInTheDocument()
    expect(await waitFor(() => screen.getByText('Nido de krobi'))).toBeInTheDocument()
  })

  it('«Resumen» when the nest does not answer: why, and «Reintentar»', async () => {
    renderPage({ online: false })
    await waitFor(() => expect(screen.getByText('El nido no responde en 192.0.2.10:8000.')).toBeInTheDocument())
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Reintentar' }).length).toBeGreaterThan(0))
  })
})

describe('settings state audit', () => {
  it('Resumen does not claim Nada pendiente when its jobs request failed', async () => {
    renderPage({ respond: r => r.pathname === '/api/lyrics/jobs' ? { status: 500, json: { detail: 'boom' } } : undefined })
    expect(await waitFor(() => screen.getByText('No se pudo cargar las letras de la biblioteca.'))).toBeInTheDocument()
    expect(screen.queryByText('Nada pendiente')).not.toBeInTheDocument()
  })
})
