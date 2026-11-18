// @vitest-environment jsdom
/** Keep waiting for a starting bundled server so a fresh installation cannot skip account creation. */
import { useState } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import Gate from './Gate'
import { forgetSetupCode, setupCodeFor } from '../setup/setupLink'
import { installFakeSettings, serverStatus } from '../settings/test-support'
import type { FakeSettings, FakeSettingsOptions } from '../settings/test-support'

const HANDSHAKE = { app: 'krobi', version: '2.1.2', instanceId: 'lib-1', isInit: true, authMethods: ['token'] }

let fake: FakeSettings | null = null
afterEach(() => {
  forgetSetupCode()
  fake?.restore()
  fake = null
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** A nest that answers, an install that holds a working credential. */
function signedIn(options: FakeSettingsOptions): FakeSettings {
  fake = installFakeSettings({
    probe: (address) => ({ ok: true, url: address, handshake: HANDSHAKE }),
    respond: (request) => (request.pathname === '/api/me' ? { status: 200, json: { id: 'u1' } } : undefined),
    ...options,
  })
  return fake
}

function renderGate() {
  return render(
    <Gate>
      <p>La biblioteca</p>
    </Gate>,
  )
}

describe('Gate', () => {
  it('opens the renderer in Vite development without native setup or sign-in', () => {
    renderGate()
    expect(screen.getByText('La biblioteca')).toBeInTheDocument()
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
  })

  it('opens the first-run wizard when no nest is chosen, and starts nothing else', async () => {
    const bridge = signedIn({ status: serverStatus({ mode: 'unchosen', baseUrl: null, reachable: false, ownedByUs: false }) })
    renderGate()

    // No welcome screen: the wizard opens on the nest choice.
    expect(await screen.findByRole('heading', { name: 'Elige tu nido' })).toBeInTheDocument()
    expect(screen.queryByText('La biblioteca')).not.toBeInTheDocument()
    expect(bridge.invokedWith('server:probe')).toHaveLength(0)
  })

  it('draws the wizard in its own night island, scoped to its own container', async () => {
    signedIn({ status: serverStatus({ mode: 'unchosen', baseUrl: null, reachable: false }) })
    renderGate()

    const heading = await screen.findByRole('heading', { name: 'Elige tu nido' })
    const surface = heading.closest('.z-root')
    // The tokens live on this container, not on <html>: the rest of the app
    // must never inherit them.
    expect(surface).not.toBeNull()
    expect(surface).toHaveClass('krobi-setup')
    expect(surface).toHaveAttribute('data-profile', 'night')
    expect(document.documentElement).not.toHaveClass('z-root')
  })

  it('lists this Mac as one of the nests, with no welcome to go back to', async () => {
    signedIn({ status: serverStatus({ mode: 'unchosen', baseUrl: null, reachable: false }) })
    renderGate()

    expect(await screen.findByRole('heading', { name: 'Elige tu nido' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Crear nido aquí' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Comenzar' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Atrás' })).not.toBeInTheDocument()
  })

  it('waits for a nest this computer is starting instead of failing open', async () => {
    const bridge = signedIn({ status: serverStatus({ mode: 'child', starting: true, reachable: false }) })
    vi.useFakeTimers()
    renderGate()
    await act(async () => {})

    expect(screen.getByRole('heading', { name: 'Conectando con tu nido…' })).toBeInTheDocument()
    // Advance the waiting screen's clock without sleeping on a busy worker.
    await act(() => vi.advanceTimersByTimeAsync(1500))
    vi.useRealTimers()
    expect(screen.queryByText('La biblioteca')).not.toBeInTheDocument()
    expect(bridge.invokedWith('server:probe')).toHaveLength(0)

    act(() => bridge.emitServerStatus(serverStatus({ mode: 'child', starting: false, reachable: true })))

    // Session verification crosses the async fake HTTP boundary.
    expect(await screen.findByText('La biblioteca', {}, { timeout: 3000 })).toBeInTheDocument()
  })

  it('shows why a nest of its own did not start, with a retry', async () => {
    const bridge = signedIn({
      status: serverStatus({ mode: 'child', starting: false, reachable: false, problem: 'start-failed' }),
    })
    renderGate()

    expect(await screen.findByRole('alert')).toHaveTextContent(/no pudo iniciar/)
    const asked = bridge.invokedWith('server:get-status').length
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }))

    expect(bridge.invokedWith('server:get-status').length).toBeGreaterThan(asked)
    expect(screen.queryByText('La biblioteca')).not.toBeInTheDocument()
  })

  it('changes a failed local nest through the setup-link step and carries its code into Account after relaunch', async () => {
    const shell = signedIn({ status: serverStatus({ mode: 'child', reachable: false, problem: 'start-failed' }) })
    const view = renderGate()
    await userEvent.click(await screen.findByRole('button', { name: 'Cambiar de nido' }))
    expect(await screen.findByRole('heading', { name: 'Elige tu nido' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Escribir una dirección' })).toBeInTheDocument()
    const code = 'abcdefghijklmnopqrstuvwx'
    const address = 'http://server.test:8001'
    // Exercise setup-link submission without scheduling one timer per character.
    fireEvent.change(screen.getByLabelText('Enlace de configuración'), { target: { value: `krobi://server.test:8001/setup#${code}` } })
    await userEvent.click(within(screen.getByLabelText('Enlace de configuración').closest('form')!).getByRole('button', { name: 'Conectar' }))
    expect(shell.invokedWith('server:use')).toEqual([{ address }])
    expect(setupCodeFor(address)).toBe(code)
    expect(JSON.stringify(shell.invocations)).not.toContain(code)
    view.unmount()
    shell.restore()
    vi.stubGlobal('desktopAPI', { backendUrl: address })
    fake = installFakeSettings({ identity: { hasToken: false }, origin: address, status: serverStatus({ mode: 'external', baseUrl: address }),
      probe: url => ({ ok: true, url, handshake: { ...HANDSHAKE, isInit: false, setupTokenRequired: true } }),
      respond: request => request.pathname === '/api/claim' ? { status: 201, json: { token: 'claimed-token' } } : undefined,
    })
    renderGate()
    expect(await screen.findByRole('heading', { name: 'Crear cuenta' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Código de instalación')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Usuario'), { target: { value: 'listener' } })
    fireEvent.change(screen.getByLabelText('Contraseña', { exact: true }), { target: { value: 'long-enough-password' } })
    fireEvent.change(screen.getByLabelText('Confirmar contraseña'), { target: { value: 'long-enough-password' } })
    await userEvent.click(screen.getByRole('button', { name: 'Crear cuenta' }))
    expect(fake.requests.find(request => request.pathname === '/api/claim')?.body).toMatchObject({ setupToken: code })
  })

  it('waits while the shell is still reaching a nest elsewhere, then opens', async () => {
    const bridge = signedIn({ status: serverStatus({ mode: 'external', ownedByUs: false, starting: true, reachable: false }) })
    renderGate()

    expect(await screen.findByRole('heading', { name: 'Conectando con tu nido…' })).toBeInTheDocument()
    expect(bridge.invokedWith('server:probe')).toHaveLength(0)

    act(() => bridge.emitServerStatus(serverStatus({ mode: 'external', ownedByUs: false, starting: false, reachable: true })))

    expect(await screen.findByText('La biblioteca')).toBeInTheDocument()
  })

  it('opens anyway when the shell stops waiting for a nest elsewhere', async () => {
    const bridge = signedIn({ status: serverStatus({ mode: 'external', ownedByUs: false, starting: true, reachable: false }) })
    renderGate()

    expect(await screen.findByRole('heading', { name: 'Conectando con tu nido…' })).toBeInTheDocument()
    act(() => bridge.emitServerStatus(serverStatus({ mode: 'external', ownedByUs: false, starting: false, reachable: false })))

    expect(await screen.findByText('La biblioteca')).toBeInTheDocument()
  })

  it('shows ordered checks and the slow notice at 10 s, without restarting on attempts', async () => {
    vi.useFakeTimers()
    const connection = { state: 'connecting' as const, since: Date.now(), attempt: 1, lastError: null, checks: [
      { id: 'this-computer' as const, status: 'ok' as const, detail: 'Wi-Fi · 192.168.1.50' },
      { id: 'route' as const, status: 'idle' as const, detail: '192.168.1.20' },
      { id: 'krobi' as const, status: 'idle' as const, detail: 'puerto 8000' },
    ] }
    const bridge = signedIn({ status: serverStatus({ mode: 'external', connection }) })
    renderGate()
    await act(async () => {})
    expect(screen.getByRole('heading', { name: 'Conectando con tu nido…' })).toBeInTheDocument()
    expect(screen.getByText('Red')).toBeInTheDocument()
    expect(screen.getByText('Equipo del nido')).toBeInTheDocument()
    expect(screen.getByText('Conectada')).toBeInTheDocument()
    expect(screen.getByText('Sin verificar')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(9999))
    expect(screen.queryByText('Está tardando más de lo normal.')).not.toBeInTheDocument()
    act(() => bridge.emitServerStatus(serverStatus({ connection: { ...connection, attempt: 10 } })))
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(screen.getByText('Está tardando más de lo normal.')).toBeInTheDocument()
    expect(bridge.invokedWith('server:probe')).toHaveLength(0)
  })

  it('opens and keeps the app when Usar sin conexión is chosen during the wait', async () => {
    const bridge = signedIn({ status: serverStatus({ mode: 'external', starting: true, reachable: false }) })
    renderGate()
    await userEvent.click(await screen.findByRole('button', { name: 'Usar sin conexión' }))
    expect(await screen.findByText('La biblioteca')).toBeInTheDocument()
    act(() => bridge.emitServerStatus(serverStatus({ starting: true, reachable: false })))
    expect(screen.getByText('La biblioteca')).toBeInTheDocument()
  })

  it('opens the wizard Nest step from the waiting screen', async () => {
    signedIn({ status: serverStatus({ mode: 'external', starting: true, reachable: false }) })
    renderGate()
    await userEvent.click(await screen.findByRole('button', { name: 'Cambiar de nido' }))
    expect(await screen.findByRole('heading', { name: 'Elige tu nido' })).toBeInTheDocument()
  })

  it('goes straight to the handshake for a nest elsewhere', async () => {
    signedIn({ status: serverStatus({ mode: 'external', ownedByUs: false }) })
    renderGate()

    expect(await screen.findByText('La biblioteca')).toBeInTheDocument()
  })

  it('never takes the app away once it has been shown', async () => {
    const bridge = signedIn({ status: serverStatus({ mode: 'child' }) })
    renderGate()
    expect(await screen.findByText('La biblioteca')).toBeInTheDocument()

    // The nest restarts underneath a running app: the badge reports it, the
    // app (and the song playing in it) stays.
    act(() => bridge.emitServerStatus(serverStatus({ mode: 'child', starting: true, reachable: false })))

    expect(screen.getByText('La biblioteca')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Conectando con tu nido…' })).not.toBeInTheDocument()
  })
  it('preserves the app opened during an outage when handshake and session resume', async () => {
    const bridge = signedIn({ status: serverStatus({ reachable: false, starting: false }) })
    function Library() {
      const [count, setCount] = useState(0)
      return <button onClick={() => setCount(count + 1)}>Selección {count}</button>
    }
    render(<Gate><Library /></Gate>)
    await userEvent.click(await screen.findByRole('button', { name: 'Selección 0' }))
    act(() => bridge.emitServerStatus(serverStatus({ starting: true, reachable: false })))
    expect(screen.getByRole('button', { name: 'Selección 1' })).toBeInTheDocument()
    act(() => bridge.emitServerStatus(serverStatus()))
    expect(await screen.findByRole('button', { name: 'Selección 1' })).toBeInTheDocument()
    await act(async () => {})
    expect(screen.getByRole('button', { name: 'Selección 1' })).toBeInTheDocument()
  })

})
