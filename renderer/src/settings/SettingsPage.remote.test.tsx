import { clockUser, installTestClock, waitForClock as waitFor } from '../test/test-clock'

import { fireEvent, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginAddons, pluginPages, pluginSettingsSections } from '../plugins'
import { HANDSHAKE, ME_NORMAL, ORIGIN, fake, renderPage } from './page-test-support'

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })

const way = (name: RegExp) => screen.getByRole('radio', { name })

/** Highlight a way, then press its Set up: the route is saved and its steps open in a popup. */
async function setUp(name: RegExp) {
  await user.click(await waitFor(() => way(name)))
  await user.click(screen.getByRole('button', { name: 'Configurar' }))
  return waitFor(() => screen.getByRole('dialog'))
}

describe('SettingsPage', () => {
  it('«Acceso remoto» on a nest without it: a version note', async () => {
    renderPage({ section: 'remoto', respond: (r) => (r.pathname === '/api/server/network' ? { status: 404, json: { detail: 'Not Found' } } : undefined) })
    expect(await waitFor(() => screen.getByText('Actualiza el nido para usar el acceso remoto.'))).toBeInTheDocument()
  })
})

describe('fundamentals fixes', () => {
  it('lists every way, and a skipped wizard setup is complete in the popup', async () => {
    renderPage({ section: 'remoto' })
    expect(await waitFor(() => screen.getAllByRole('radio'))).toHaveLength(4)
    const steps = await setUp(/Tailscale/)
    expect(within(steps).getByText('sudo tailscale up')).toBeInTheDocument()
    expect(within(steps).getByText('curl -fsSL https://tailscale.com/install.sh | sh')).toBeInTheDocument()
    const reads = () => fake!.requests.filter(r => r.pathname === '/api/server/network').length
    const before = reads()
    await user.click(within(steps).getByRole('button', { name: 'Reintentar' }))
    await waitFor(() => expect(reads()).toBeGreaterThan(before))
    await user.click(within(steps).getByRole('button', { name: 'Cerrar' }))

    const domain = await setUp(/Dominio con HTTPS/)
    // Route validation needs the completed draft, not timed keystrokes.
    fireEvent.change(within(domain).getByLabelText('Dominio'), { target: { value: 'musica.ejemplo.com' } })
    expect(within(domain).getByText(/reverse_proxy 192\.0\.2\.10:8000/)).toBeInTheDocument()
    await user.click(within(domain).getByRole('button', { name: 'Revisar' }))
    await waitFor(() => expect(within(domain).getByRole('button', { name: 'Guardar' })).toBeEnabled())
    expect(screen.getByText('No abras el puerto 8000 en tu router.')).toBeInTheDocument()
  })

  it('normal accounts see every way and the address list, read-only', async () => {
    renderPage({ section: 'remoto', me: ME_NORMAL })
    expect(await waitFor(() => screen.getByRole('list', { name: 'Direcciones' }))).toHaveTextContent(ORIGIN)
    expect(screen.getAllByRole('radio')).toHaveLength(4)
    for (const row of screen.getAllByRole('radio')) expect(row).toHaveAttribute('aria-disabled', 'true')
    expect(screen.queryByRole('button', { name: 'Configurar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Revisar' })).not.toBeInTheDocument()
  })
})

describe('remote settings controls', () => {
  it('copies both install commands and the generated Caddyfile', async () => {
    const copy = vi.spyOn(navigator.clipboard, 'writeText')
    renderPage({ section: 'remoto' })
    const steps = await setUp(/Tailscale/)
    const buttons = within(steps).getAllByRole('button', { name: 'copiar' })
    await user.click(buttons[0])
    expect(copy).toHaveBeenLastCalledWith('curl -fsSL https://tailscale.com/install.sh | sh')
    await user.click(buttons[1])
    expect(copy).toHaveBeenLastCalledWith('sudo tailscale up')
    await user.click(within(steps).getByRole('button', { name: 'Cerrar' }))
    const domain = await setUp(/Dominio con HTTPS/)
    fireEvent.change(within(domain).getByLabelText('Dominio'), { target: { value: 'musica.ejemplo.com' } })
    await user.click(within(domain).getAllByRole('button', { name: 'copiar' })[0])
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
    const steps = await setUp(/Dominio con HTTPS/)
    // Route validation needs the completed draft, not timed keystrokes.
    fireEvent.change(within(steps).getByLabelText('Dominio'), { target: { value: 'musica.ejemplo.com' } })
    expect(within(steps).getByRole('button', { name: 'Guardar' })).toBeDisabled()
    await user.click(within(steps).getByRole('button', { name: 'Revisar' }))
    expect(await waitFor(() => screen.getByText('Sin respuesta'))).toHaveAttribute('title', 'Desde tu red puede fallar aunque funcione fuera de casa.')
    await user.click(within(steps).getByRole('button', { name: 'Guardar' }))
    expect(await waitFor(() => screen.getByText('Dominio guardado'))).toBeInTheDocument()
    expect(domain).toBe('https://musica.ejemplo.com')
    await user.click(within(steps).getByRole('button', { name: 'Quitar' }))
    expect(await waitFor(() => screen.getByText('Dominio quitado'))).toBeInTheDocument()
    expect(domain).toBeNull()
    // The popup closes so the toast's undo is reachable.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
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
    const row = await waitFor(() => way(/WireGuard/))
    expect(row).toHaveAttribute('aria-checked', 'true')
    expect(row).toHaveAttribute('data-active', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Disponible fuera de casaWireGuard · hace 2 h')
    expect(document.querySelectorAll('.kob-chain__link[data-v="ok"]')).toHaveLength(2)
    // Highlighting a way changes nothing; its own button does.
    await user.click(way(/Solo red local/))
    expect(fake!.requests.some(r => r.pathname === '/api/server/remote-route')).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Usar' }))
    await waitFor(() => expect(route).toBe('local'))
    expect(fake!.requests.find(r => r.pathname === '/api/server/remote-route')?.body).toEqual({ route: 'local' })
    view.unmount()
    pluginAddons.length = 0
    pluginSettingsSections.length = 0
    pluginPages.length = 0
    fake?.restore()
    renderPage({ section: 'remoto', respond: r => r.pathname === '/api/server/network' ? { status: 200, json: { lan: [ORIGIN], tailscale: null, externalUrl: null, route, outside } } : undefined })
    expect(await waitFor(() => way(/Solo red local/))).toHaveAttribute('data-active', 'true')
    expect(screen.getByRole('status')).toHaveTextContent('Solo red local')
  })

  it('keeps the stored route and reports a failed write inline', async () => {
    renderPage({ section: 'remoto', respond: r => r.pathname === '/api/server/remote-route' ? { status: 500, json: { detail: 'boom' } } : undefined })
    await user.click(await waitFor(() => way(/WireGuard/)))
    await user.click(screen.getByRole('button', { name: 'Configurar' }))
    expect(await waitFor(() => screen.getByRole('alert'))).toHaveTextContent('No se pudo guardar el acceso remoto.')
    expect(way(/Solo red local/)).toHaveAttribute('data-active', 'true')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it.each([null, { at: new Date(Date.now() - 7200_000).toISOString(), via: 'vpn' }])('Resumen uses WireGuard proof before visiting remote settings: %j', async outside => {
    renderPage({ respond: r => r.pathname === '/api/server/network' ? { status: 200, json: { lan: [ORIGIN], tailscale: null, externalUrl: null, route: 'wireguard', outside } } : undefined })
    await waitFor(() => screen.getByText('254 canciones'))
    if (outside) expect(screen.queryByText('Acceso remoto sin verificar')).not.toBeInTheDocument()
    else expect(await waitFor(() => screen.getByText('Acceso remoto sin verificar'))).toBeInTheDocument()
  })

  it('a member sees the stored route, cannot change it, and never PUTs', async () => {
    renderPage({ section: 'remoto', me: ME_NORMAL, respond: r => r.pathname === '/api/server/network' ? { status: 200, json: { lan: [ORIGIN], tailscale: null, externalUrl: null, route: 'wireguard', outside: null } } : undefined })
    const row = await waitFor(() => way(/WireGuard/))
    expect(row).toHaveAttribute('aria-checked', 'true')
    await user.click(way(/Solo red local/))
    expect(row).toHaveAttribute('aria-checked', 'true')
    expect(screen.queryByRole('button', { name: 'Usar' })).not.toBeInTheDocument()
    expect(fake!.requests.some(r => r.method === 'PUT')).toBe(false)
  })
})

describe('Tailscale steps', () => {
  const tailscale = { ip: '100.64.0.12', name: 'nest.tail0000.ts.net', url: 'http://100.64.0.12:8000' }

  it('ticks this computer and the phone from what the nest reports, and gives the music app its address', async () => {
    const outside = { at: new Date(Date.now() - 600_000).toISOString(), via: 'tailscale' }
    renderPage({ section: 'remoto', respond: r => r.pathname === '/api/server/network'
      ? { status: 200, json: { lan: [ORIGIN], tailscale, externalUrl: null, route: 'tailscale', outside } }
      : undefined })
    expect(await waitFor(() => way(/Tailscale/))).toHaveTextContent('Listo')
    await user.click(screen.getByRole('button', { name: 'Abrir' }))
    const steps = await waitFor(() => screen.getByRole('dialog'))
    expect(within(steps).getByText('Instalado')).toBeInTheDocument()
    expect(within(steps).getByText('nest.tail0000.ts.net')).toBeInTheDocument()
    expect(within(steps).getByText('Conectado')).toBeInTheDocument()
    expect(within(steps).getByText('Server address for your Subsonic app').nextElementSibling).toHaveTextContent(tailscale.url)
    expect(within(steps).getByRole('button', { name: 'Agregar una app de música' })).toHaveClass('z-btn--soft')
  })

  it('offers the home address as the nest network one bit wider, so the phone Wi-Fi wins at home', async () => {
    renderPage({ section: 'remoto', respond: r => r.pathname === '/api/server/network'
      ? { status: 200, json: { lan: [ORIGIN], lanNetworks: ['10.1.2.0/24'], tailscale, externalUrl: null, route: 'tailscale', outside: null } }
      : undefined })
    await waitFor(() => way(/Tailscale/))
    await user.click(screen.getByRole('button', { name: 'Configurar' }))
    const steps = await waitFor(() => screen.getByRole('dialog'))
    await user.click(within(steps).getByRole('button', { name: 'Use my home address instead' }))
    expect(within(steps).getByText('tailscale set --advertise-routes=10.1.2.0/23')).toBeInTheDocument()
    expect(within(steps).getByRole('button', { name: 'Open Tailscale' })).toHaveClass('z-btn--soft')
    expect(within(steps).getByText('Add your music app')).toBeInTheDocument()
    expect(within(steps).getByText('Server address for your Subsonic app').nextElementSibling).toHaveTextContent(ORIGIN)
    expect(within(steps).getByRole('button', { name: 'Agregar una app de música' })).toHaveClass('z-btn--soft')
  })

  it('offers no home address when the nest does not report its network', async () => {
    renderPage({ section: 'remoto', respond: r => r.pathname === '/api/server/network'
      ? { status: 200, json: { lan: [ORIGIN], tailscale, externalUrl: null, route: 'tailscale', outside: null } }
      : undefined })
    await waitFor(() => way(/Tailscale/))
    await user.click(screen.getByRole('button', { name: 'Configurar' }))
    const steps = await waitFor(() => screen.getByRole('dialog'))
    expect(within(steps).queryByRole('button', { name: 'Use my home address instead' })).not.toBeInTheDocument()
  })
})
