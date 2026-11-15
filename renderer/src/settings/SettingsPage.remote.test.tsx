import { clockUser, installTestClock, waitForClock as waitFor } from '../test/test-clock'

import { fireEvent, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginAddons, pluginPages, pluginSettingsSections } from '../plugins'
import { HANDSHAKE, ME_NORMAL, ORIGIN, fake, renderPage } from './page-test-support'

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


describe('SettingsPage', () => {
  it('«Acceso remoto» on a nest without it: a version note', async () => {
    renderPage({ section: 'remoto', respond: (r) => (r.pathname === '/api/server/network' ? { status: 404, json: { detail: 'Not Found' } } : undefined) })
    expect(await waitFor(() => screen.getByText('Actualiza el nido para usar el acceso remoto.'))).toBeInTheDocument()
  })
})

describe('fundamentals fixes', () => {
  it('remote setup skipped in the wizard remains complete in Settings', async () => {
    renderPage({ section: 'remoto' })
    await user.click(await waitFor(() => screen.getByRole('radio', { name: /Tailscale/ })))
    expect(await waitFor(() => screen.getByText('sudo tailscale up'))).toBeInTheDocument()
    expect(screen.getAllByRole('radio')).toHaveLength(4)
    expect(screen.getByText('curl -fsSL https://tailscale.com/install.sh | sh')).toBeInTheDocument()
    const reads = () => fake!.requests.filter(r => r.pathname === '/api/server/network').length
    const before = reads()
    await user.click(screen.getByRole('button', { name: 'Reintentar' }))
    await waitFor(() => expect(reads()).toBeGreaterThan(before))
    await user.click(screen.getByRole('radio', { name: /Dominio con HTTPS/ }))
    // Route validation needs the completed draft, not timed keystrokes.
    fireEvent.change(screen.getByLabelText('Dominio'), { target: { value: 'musica.ejemplo.com' } })
    expect(screen.getByText(/reverse_proxy 192\.0\.2\.10:8000/)).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Direcciones' })).toHaveTextContent('https://musica.ejemplo.com')
    await user.click(screen.getByRole('button', { name: 'Revisar' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Guardar' })).toBeEnabled())
    expect(screen.getByText('No abras el puerto 8000 en tu router.')).toBeInTheDocument()
  })

  it('normal accounts see the chosen route and read-only address list', async () => {
    renderPage({ section: 'remoto', me: ME_NORMAL })
    expect(await waitFor(() => screen.getByRole('list', { name: 'Direcciones' }))).toHaveTextContent(ORIGIN)
    expect(screen.getAllByRole('radio')).toHaveLength(4)
    for (const card of screen.getAllByRole('radio')) expect(card).toBeDisabled()
    expect(screen.queryByLabelText('Dominio')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revisar' })).not.toBeInTheDocument()
  })
})

describe('remote settings controls', () => {
  it('copies both install commands and the generated Caddyfile', async () => {
    const user = clockUser()
    const copy = vi.spyOn(navigator.clipboard, 'writeText')
    renderPage({ section: 'remoto' })
    await user.click(await waitFor(() => screen.getByRole('radio', { name: /Tailscale/ })))
    await waitFor(() => screen.getByText('sudo tailscale up'))
    const buttons = screen.getAllByRole('button', { name: 'copiar' })
    await user.click(buttons[0])
    expect(copy).toHaveBeenLastCalledWith('curl -fsSL https://tailscale.com/install.sh | sh')
    await user.click(buttons[1])
    expect(copy).toHaveBeenLastCalledWith('sudo tailscale up')
    await user.click(screen.getByRole('radio', { name: /Dominio con HTTPS/ }))
    fireEvent.change(screen.getByLabelText('Dominio'), { target: { value: 'musica.ejemplo.com' } })
    await user.click(screen.getAllByRole('button', { name: 'copiar' })[0])
    expect(copy).toHaveBeenLastCalledWith('musica.ejemplo.com {\n\treverse_proxy 192.0.2.10:8000\n}')
  })

  it('allows an unreachable domain only after checking, removes it and offers undo', async () => {
    let domain: string | null = null
    renderPage({ section: 'remoto', probe: address => address === ORIGIN
      ? { ok: true, url: ORIGIN, handshake: HANDSHAKE }
      : { ok: false, reason: 'unreachable' }, respond: r => {
      if (r.pathname === '/api/server/network') return { status: 200, json: { lan: [ORIGIN], tailscale: null, externalUrl: domain } }
      if (r.pathname === '/api/server/external-url') {
        domain = (r.body as { url: string | null }).url
        return { status: 200, json: { externalUrl: domain } }
      }
      return undefined
    } })
    await user.click(await waitFor(() => screen.getByRole('radio', { name: /Dominio con HTTPS/ })))
    // Route validation needs the completed draft, not timed keystrokes.
    fireEvent.change(screen.getByLabelText('Dominio'), { target: { value: 'musica.ejemplo.com' } })
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Revisar' }))
    expect(await waitFor(() => screen.getByText('Sin respuesta'))).toHaveAttribute('title', 'Desde tu red puede fallar aunque funcione fuera de casa.')
    await user.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(await waitFor(() => screen.getByText('Dominio guardado'))).toBeInTheDocument()
    expect(domain).toBe('https://musica.ejemplo.com')
    await user.click(screen.getByRole('button', { name: 'Quitar' }))
    expect(await waitFor(() => screen.getByText('Dominio quitado'))).toBeInTheDocument()
    expect(domain).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Deshacer' }))
    await waitFor(() => expect(domain).toBe('https://musica.ejemplo.com'))
  })
})

describe('chosen remote route', () => {
  it('opens on the stored WireGuard route, shows visit proof, and saves a change', async () => {
    let route = 'wireguard'
    const outside = { at: new Date(Date.now() - 7200_000).toISOString(), via: 'vpn' }
    const view = renderPage({ section: 'remoto', respond: r => {
      if (r.pathname === '/api/server/network') return { status: 200, json: { lan: [ORIGIN], tailscale: null, externalUrl: null, route, outside } }
      if (r.pathname === '/api/server/remote-route') { route = (r.body as { route: string }).route; return { status: 200, json: { route } } }
      return undefined
    } })
    const card = await waitFor(() => screen.getByRole('radio', { name: 'WireGuardVPN del router' }))
    expect(card).toHaveAttribute('aria-checked', 'true')
    expect(card.querySelector('.kob-choice__icon > .kob-choice__badge')).toHaveAttribute('data-v', 'ok')
    expect(card.querySelector('.kob-choice__badge')).toHaveAttribute('aria-hidden', 'true')
    expect(document.querySelectorAll('.kob-choice__badge')).toHaveLength(1)
    expect(screen.getByRole('status')).toHaveTextContent('Disponible fuera de casaWireGuard · hace 2 h')
    expect(document.querySelectorAll('.kob-chain__link[data-v="ok"]')).toHaveLength(2)
    await user.click(screen.getByRole('radio', { name: /Solo red local/ }))
    await waitFor(() => expect(route).toBe('local'))
    expect(fake!.requests.find(r => r.pathname === '/api/server/remote-route')?.body).toEqual({ route: 'local' })
    view.unmount()
    pluginAddons.length = 0
  pluginSettingsSections.length = 0
  pluginPages.length = 0
  fake?.restore()
    renderPage({ section: 'remoto', respond: r => r.pathname === '/api/server/network' ? { status: 200, json: { lan: [ORIGIN], tailscale: null, externalUrl: null, route, outside } } : undefined })
    expect(await waitFor(() => screen.getByRole('radio', { name: /Solo red local/ }))).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Solo red local')
    expect(document.querySelector('.kob-choice__badge')).toBeNull()
  })

  it('keeps the selected route and reports a failed write inline', async () => {
    renderPage({ section: 'remoto', respond: r => r.pathname === '/api/server/remote-route' ? { status: 500, json: { detail: 'boom' } } : undefined })
    await user.click(await waitFor(() => screen.getByRole('radio', { name: /WireGuard/ })))
    expect(await waitFor(() => screen.getByRole('alert'))).toHaveTextContent('No se pudo guardar el acceso remoto.')
    expect(screen.getByRole('radio', { name: /Solo red local/ })).toHaveAttribute('aria-checked', 'true')
  })

  it.each([null, { at: new Date(Date.now() - 7200_000).toISOString(), via: 'vpn' }])('Resumen uses WireGuard proof before visiting remote settings: %j', async outside => {
    renderPage({ respond: r => r.pathname === '/api/server/network' ? { status: 200, json: { lan: [ORIGIN], tailscale: null, externalUrl: null, route: 'wireguard', outside } } : undefined })
    await waitFor(() => screen.getByText('254 canciones'))
    if (outside) expect(screen.queryByText('Acceso remoto sin verificar')).not.toBeInTheDocument()
    else expect(await waitFor(() => screen.getByText('Acceso remoto sin verificar'))).toBeInTheDocument()
  })

  it('a member sees the stored route, cannot change it, and never PUTs', async () => {
    renderPage({ section: 'remoto', me: ME_NORMAL, respond: r => r.pathname === '/api/server/network' ? { status: 200, json: { lan: [ORIGIN], tailscale: null, externalUrl: null, route: 'wireguard', outside: null } } : undefined })
    const card = await waitFor(() => screen.getByRole('radio', { name: /WireGuard/ }))
    expect(card).toHaveAttribute('aria-checked', 'true')
    expect(card).toHaveAccessibleName('WireGuardVPN del router')
    expect(card.querySelector('.kob-choice__badge')).toHaveAttribute('data-v', 'none')
    expect(card.querySelector('.kob-choice__badge')).toHaveAttribute('aria-hidden', 'true')
    expect(card.querySelector('.kob-choice__badge circle')).toBeInTheDocument()
    expect(document.querySelectorAll('.kob-choice__badge')).toHaveLength(1)
    await user.click(screen.getByRole('radio', { name: /Solo red local/ }))
    expect(card).toHaveAttribute('aria-checked', 'true')
    expect(fake!.requests.some(r => r.method === 'PUT')).toBe(false)
  })
})
