import { installTestClock, clockUser, waitForClock as waitFor } from '../test/test-clock'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { KrobiBridge } from '../lib/ipc'

import { serverStatus } from '../settings/test-support'
import { DataProvider } from '../data'
import { setFakeBridgeForTest } from '../bridge'
import { AuthGate } from './AuthGate'
import { CreateAccount } from './CreateAccount'
import { SignIn } from './SignIn'

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


let restoreBridge: (() => void) | null = null
const originalFetch = globalThis.fetch

afterEach(() => {
  restoreBridge?.()
  restoreBridge = null
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

/** Records what main was asked to store, so a test can assert the token landed. */
function fakeBridge(answers: Record<string, unknown> = {}) {
  const calls: Array<{ channel: string; request: unknown }> = []
  const fake = {
    invoke: async (channel: string, request: unknown) => {
      calls.push({ channel, request })
      if (channel === 'auth:set') return { ok: true, persisted: true }
      if (channel === 'server:get-status') return serverStatus((answers[channel] ?? {}) as Parameters<typeof serverStatus>[0])
      return answers[channel]
    },
    on: () => () => {},
  } as unknown as KrobiBridge
  restoreBridge = setFakeBridgeForTest(fake)
  return calls
}

/** Accept Request objects as well as URL strings so the fake matches the real client transport. */
function fakeHttp(routes: Record<string, { status: number; body?: unknown }>) {
  const seen: Array<{ url: string; body: unknown }> = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null
    const url = request ? request.url : String(input)
    const match = Object.keys(routes).find((route) => url.includes(route))
    if (!match) throw new Error(`no fake for ${url}`)

    const rawBody = request ? await request.clone().text() : init?.body ? String(init.body) : ''
    seen.push({ url, body: rawBody ? JSON.parse(rawBody) : null })

    const answer = routes[match] as { status: number; body?: unknown }
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return seen
}

const withData = (node: React.ReactNode) => render(<DataProvider>{node}</DataProvider>)

beforeEach(() => {
  fakeBridge({ 'app:get-backend-origin': { origin: 'http://server.test' } })
})

describe('creating the first account', () => {
  it('sends the credentials and stores the token main hands back', async () => {
    const calls = fakeBridge({ 'app:get-backend-origin': { origin: 'http://server.test' } })
    const requests = fakeHttp({
      '/api/claim': { status: 201, body: { user: { id: 'u1', label: 'robin' }, token: 'tok-123' } },
    })
    const onCreated = vi.fn()
    withData(<CreateAccount onCreated={onCreated} />)

    fireEvent.change(screen.getByLabelText('Usuario'), { target: { value: 'robin' } })
    fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 'una-contra-larga' } })
    fireEvent.change(screen.getByLabelText('Repite la contraseña'), { target: { value: 'una-contra-larga' } })
    await user.click(screen.getByRole('button', { name: 'Crear la cuenta' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(requests[0]?.body).toMatchObject({ username: 'robin', password: 'una-contra-larga' })
    // The server returns a token only once; hand it to the shell before other work can fail.
    expect(calls.some((c) => c.channel === 'auth:set' && (c.request as { token: string }).token === 'tok-123')).toBe(true)
  })

  it('will not submit until the password is long enough and matches', async () => {
    fakeHttp({ '/api/claim': { status: 201 } })
    withData(<CreateAccount onCreated={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Usuario'), { target: { value: 'robin' } })
    fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 'corta' } })
    expect(screen.getByRole('button', { name: 'Crear la cuenta' })).toBeDisabled()

    await user.clear(screen.getByLabelText('Contraseña'))
    fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 'una-contra-larga' } })
    fireEvent.change(screen.getByLabelText('Repite la contraseña'), { target: { value: 'otra-cosa-larga' } })
    expect(await waitFor(() => screen.getByRole('alert'))).toHaveTextContent('no coinciden')
    expect(screen.getByRole('button', { name: 'Crear la cuenta' })).toBeDisabled()
  })

  it('asks for the setup code only when the server requires it', async () => {
    fakeHttp({ '/api/claim': { status: 201 } })
    const { unmount } = withData(<CreateAccount onCreated={vi.fn()} />)
    expect(screen.queryByLabelText('Código de instalación')).not.toBeInTheDocument()
    unmount()

    withData(<CreateAccount setupTokenRequired onCreated={vi.fn()} />)
    expect(await waitFor(() => screen.getByLabelText('Código de instalación'))).toBeInTheDocument()
  })

  it('claims a nest this computer hosts with the shell\'s setup token, never showing the field', async () => {
    const calls = fakeBridge({
      'app:get-backend-origin': { origin: 'http://server.test' },
      'server:get-status': { mode: 'child' },
      'server:local-setup-token': { token: 'setup-secret' },
      'app:get-device-name': { name: 'Mac de Robin' },
    })
    const requests = fakeHttp({
      '/api/claim': { status: 201, body: { user: { id: 'u1', label: 'robin' }, token: 'tok-123' } },
    })
    const onCreated = vi.fn()
    withData(<CreateAccount setupTokenRequired onCreated={onCreated} />)

    expect(screen.getByText('Este nido es nuevo.')).toBeInTheDocument()
    await waitFor(() => expect(calls.some((c) => c.channel === 'server:local-setup-token')).toBe(true))
    await user.type(screen.getByLabelText('Usuario'), 'robin')
    await user.type(screen.getByLabelText('Contraseña'), 'una-contra-larga')
    await user.type(screen.getByLabelText('Repite la contraseña'), 'una-contra-larga')
    // The person at this keyboard is not a stranger: no code to type.
    expect(screen.queryByLabelText('Código de instalación')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Crear la cuenta' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(requests[0]?.body).toMatchObject({ setupToken: 'setup-secret' })
    // The nest name is public (/api/status, mDNS): the claim never names it after the computer.
    expect(requests[0]?.body).not.toHaveProperty('nestName')
    expect(calls.find((c) => c.channel === 'auth:set')?.request).toMatchObject({ label: 'Mac de Robin', role: 'owner' })
  })

  it('never asks the shell for a token when the nest is remote', async () => {
    const calls = fakeBridge({
      'app:get-backend-origin': { origin: 'http://server.test' },
      'server:get-status': { mode: 'external' },
      'server:local-setup-token': { token: 'should-not-be-read' },
    })
    fakeHttp({ '/api/claim': { status: 201 } })
    withData(<CreateAccount setupTokenRequired onCreated={vi.fn()} />)

    expect(await waitFor(() => screen.getByLabelText('Código de instalación'))).toBeInTheDocument()
    expect(calls.some((c) => c.channel === 'server:local-setup-token')).toBe(false)
  })

  it('says the server was claimed by somebody else rather than "try again"', async () => {
    fakeHttp({ '/api/claim': { status: 409, body: { detail: 'already claimed' } } })
    withData(<CreateAccount onCreated={vi.fn()} />)

    await user.type(screen.getByLabelText('Usuario'), 'robin')
    await user.type(screen.getByLabelText('Contraseña'), 'una-contra-larga')
    await user.type(screen.getByLabelText('Repite la contraseña'), 'una-contra-larga')
    await user.click(screen.getByRole('button', { name: 'Crear la cuenta' }))

    expect(await waitFor(() => screen.getByRole('alert'))).toHaveTextContent(/ya tiene una cuenta/)
  })
})

describe('signing in', () => {
  it('mints a device token for this machine and stores it', async () => {
    const calls = fakeBridge({ 'app:get-backend-origin': { origin: 'http://server.test' } })
    const requests = fakeHttp({
      '/api/login': { status: 201, body: { device: { id: 'd1' }, token: 'tok-abc' } },
    })
    const onSignedIn = vi.fn()
    withData(<SignIn onSignedIn={onSignedIn} />)

    await user.type(screen.getByLabelText('Usuario'), 'robin')
    await user.type(screen.getByLabelText('Contraseña'), 'una-contra-larga')
    await user.click(screen.getByRole('button', { name: 'Entrar' }))

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
    expect(requests[0]?.body).toMatchObject({ username: 'robin', deviceLabel: expect.any(String) })
    expect(calls.some((c) => c.channel === 'auth:set')).toBe(true)
  })

  it('names the new device after this computer', async () => {
    const calls = fakeBridge({
      'app:get-backend-origin': { origin: 'http://server.test' },
      'app:get-device-name': { name: 'Mac de Robin' },
    })
    const requests = fakeHttp({
      '/api/login': { status: 201, body: { device: { id: 'd1' }, token: 'tok-abc' } },
    })
    const onSignedIn = vi.fn()
    withData(<SignIn onSignedIn={onSignedIn} />)
    await waitFor(() => expect(calls.some((c) => c.channel === 'app:get-device-name')).toBe(true))

    await user.type(screen.getByLabelText('Usuario'), 'robin')
    await user.type(screen.getByLabelText('Contraseña'), 'una-contra-larga')
    await user.click(screen.getByRole('button', { name: 'Entrar' }))

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
    expect(requests[0]?.body).toMatchObject({ deviceLabel: 'Mac de Robin' })
    expect(calls.find((c) => c.channel === 'auth:set')?.request).toMatchObject({ label: 'Mac de Robin' })
  })

  it('falls back to a generic label when the shell cannot say', async () => {
    fakeBridge({ 'app:get-backend-origin': { origin: 'http://server.test' } })
    const requests = fakeHttp({
      '/api/login': { status: 201, body: { device: { id: 'd1' }, token: 'tok-abc' } },
    })
    const onSignedIn = vi.fn()
    withData(<SignIn onSignedIn={onSignedIn} />)

    await user.type(screen.getByLabelText('Usuario'), 'robin')
    await user.type(screen.getByLabelText('Contraseña'), 'una-contra-larga')
    await user.click(screen.getByRole('button', { name: 'Entrar' }))

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
    expect(requests[0]?.body).toMatchObject({ deviceLabel: 'Computadora' })
  })

  it('gives one sentence for any wrong credential, and clears the password', async () => {
    fakeHttp({ '/api/login': { status: 401, body: { detail: 'nope' } } })
    withData(<SignIn onSignedIn={vi.fn()} />)

    await user.type(screen.getByLabelText('Usuario'), 'quienquiera')
    await user.type(screen.getByLabelText('Contraseña'), 'lo-que-sea-x')
    await user.click(screen.getByRole('button', { name: 'Entrar' }))

    // The server refuses to distinguish a wrong username from a wrong
    // password. Saying which was wrong here would hand back the account oracle
    // it went to the trouble of denying.
    expect(await waitFor(() => screen.getByRole('alert'))).toHaveTextContent('Usuario o contraseña incorrectos.')
    expect(screen.getByLabelText('Contraseña')).toHaveValue('')
  })

  it('says the throttle does not lock out devices that already work', async () => {
    fakeHttp({ '/api/login': { status: 429, body: { detail: 'slow down' } } })
    withData(<SignIn onSignedIn={vi.fn()} />)

    await user.type(screen.getByLabelText('Usuario'), 'robin')
    await user.type(screen.getByLabelText('Contraseña'), 'una-contra-larga')
    await user.click(screen.getByRole('button', { name: 'Entrar' }))

    expect(await waitFor(() => screen.getByRole('alert'))).toHaveTextContent(/siguen funcionando/)
  })
})

describe('the gate', () => {
  it('lets a signed-in install straight through', async () => {
    fakeBridge({ 'app:get-backend-origin': { origin: 'http://server.test' }, 'auth:get': { hasToken: true } })
    fakeHttp({ '/api/me': { status: 200, body: { id: 'u1', label: 'robin' } } })

    withData(
      <AuthGate serverIsInit>
        <p>La biblioteca</p>
      </AuthGate>,
    )

    expect(await waitFor(() => screen.getByText('La biblioteca'))).toBeInTheDocument()
  })

  it('offers account creation on a server that has nobody on it', async () => {
    fakeBridge({ 'app:get-backend-origin': { origin: 'http://server.test' }, 'auth:get': { hasToken: false } })
    fakeHttp({ '/api/me': { status: 401 } })

    withData(
      <AuthGate serverIsInit={false}>
        <p>La biblioteca</p>
      </AuthGate>,
    )

    // A desktop with a chosen nest resumes at "Create account".
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Crear cuenta' }))).toBeInTheDocument()
  })

  it('asks a revoked credential to sign in again, and does NOT call it an outage', async () => {
    fakeBridge({ 'app:get-backend-origin': { origin: 'http://server.test' }, 'auth:get': { hasToken: true } })
    fakeHttp({ '/api/me': { status: 401 } })

    withData(
      <AuthGate serverIsInit>
        <p>La biblioteca</p>
      </AuthGate>,
    )

    // A revoked token requires sign-in even when the server is reachable.
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Iniciar sesión' }))).toBeInTheDocument()
    expect(screen.queryByText(/no respondió/i)).not.toBeInTheDocument()
  })

  it('lets an older server through rather than locking somebody out over a version', async () => {
    fakeBridge({ 'app:get-backend-origin': { origin: 'http://server.test' }, 'auth:get': { hasToken: true } })
    fakeHttp({ '/api/me': { status: 404 } })

    withData(
      <AuthGate serverIsInit>
        <p>La biblioteca</p>
      </AuthGate>,
    )

    expect(await waitFor(() => screen.getByText('La biblioteca'))).toBeInTheDocument()
  })
})

// The pre-merge Shell marks `show` aria-hidden. These interaction queries include
// hidden content until FR-A removes that attribute for the interactive panel.
// EVIDENCE-FR-B.md records this integration requirement.
describe('sign in by code', () => {
  async function start() {
    await user.type(screen.getByLabelText('Usuario'), 'ana')
    await user.click(screen.getByRole('button', { name: 'Continuar', hidden: true }))
  }

  it('asks the username, shows the grouped code and countdown, and stores the authorized device', async () => {
    const calls = fakeBridge({ 'app:get-backend-origin': { origin: 'http://server.test' } })
    const pending = { status: 200, body: { credential: null } as { credential: null | { token: string; device: { id: string } } } }
    const requests = fakeHttp({
      '/api/me': { status: 200, body: { username: 'Ana' } },
      '/api/sign-in-code/poll': pending,
      '/api/sign-in-code': { status: 201, body: { code: 'ABC234', secret: 'requester-secret', expiresIn: 600, pollInterval: 0.02 } },
    })
    const onSignedIn = vi.fn()
    withData(<SignIn serverLabel="Nido de casa" onSignedIn={onSignedIn} />)
    await start()
    expect(await waitFor(() => screen.getByLabelText('Código'))).toHaveTextContent('ABC 234')
    expect(screen.getByText('vence en 10:00')).toBeInTheDocument()
    expect(screen.getByText('Esperando aprobación…')).toBeInTheDocument()
    expect(screen.getByLabelText('Contraseña')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(document.querySelector('.ksr-address')).toBeNull()
    expect(requests[0]?.body).toMatchObject({ username: 'ana' })
    await waitFor(() => expect(requests.some(r => r.url.endsWith('/poll'))).toBe(true))
    pending.body.credential = { token: 'new-device-token', device: { id: 'd-new' } }
    expect(await waitFor(() => screen.getByText('Listo'))).toBeInTheDocument()
    expect(await waitFor(() => screen.getByText('entrando como Ana…'))).toBeInTheDocument()
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce(), { timeout: 2500 })
    expect(calls.some(c => c.channel === 'auth:set' && (c.request as { token: string }).token === 'new-device-token')).toBe(true)
  })

  it('keeps the code panel neutral and leaves the only primary action in the footer', async () => {
    fakeHttp({
      '/api/sign-in-code': { status: 201, body: { code: 'ABC234', secret: 'secret', expiresIn: 600, pollInterval: 2 } },
    })
    const { container } = withData(<SignIn onSignedIn={vi.fn()} />)
    await start()
    expect(await waitFor(() => screen.getByLabelText('Código'))).toHaveTextContent('ABC 234')
    const panel = container.querySelector('.kob-code-sign-in')!
    expect(within(panel as HTMLElement).getByText('Esperando aprobación…').querySelector('.kob-dot')).toHaveClass('is-wait')
    expect(panel.querySelector('[class*="coral"], .kob-btn--coral, .z-btn--coral, .ksr-ping')).toBeNull()
    expect(container.querySelectorAll('.kob-btn--coral')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Entrar' })).toHaveAttribute('form', 'kob-sign-in')
  })

  it('cancels the old account code when the shared username changes', async () => {
    const requests = fakeHttp({
      '/api/sign-in-code/poll': { status: 200, body: { credential: null } },
      '/api/sign-in-code': { status: 201, body: { code: 'ABC234', secret: 'secret', expiresIn: 600, pollInterval: 0.02 } },
    })
    withData(<SignIn onSignedIn={vi.fn()} />)
    await start()
    expect(await waitFor(() => screen.getByLabelText('Código'))).toBeInTheDocument()
    await user.clear(screen.getByLabelText('Usuario'))
    await user.type(screen.getByLabelText('Usuario'), 'robin')
    expect(screen.queryByLabelText('Código')).toBeNull()
    const count = requests.length
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(requests).toHaveLength(count)
    expect(screen.getByLabelText('Contraseña')).toBeInTheDocument()
  })

  it('renews an expired code automatically', async () => {
    let made = 0
    globalThis.fetch = (async () => new Response(JSON.stringify({ code: ++made === 1 ? 'ABC234' : 'DEF567', secret: 'secret', expiresIn: made === 1 ? 0 : 600, pollInterval: 2 }), { status: 201, headers: { 'content-type': 'application/json' } })) as typeof fetch
    withData(<SignIn onSignedIn={vi.fn()} />)
    await start()
    expect(await waitFor(() => screen.getByText('Código nuevo'))).toBeInTheDocument()
    expect(screen.getByLabelText('Código')).toHaveTextContent('DEF 567')
    expect(made).toBe(2)
    await user.click(screen.getByRole('button', { name: 'Entrar con contraseña', hidden: true }))
    expect(screen.getByLabelText('Contraseña')).toBeInTheDocument()
  })

  it('stops polling after decline and offers another code', async () => {
    const requests = fakeHttp({
      '/api/sign-in-code/poll': { status: 200, body: { declined: true } },
      '/api/sign-in-code': { status: 201, body: { code: 'ABC234', secret: 'secret', expiresIn: 600, pollInterval: 0.02 } },
    })
    withData(<SignIn onSignedIn={vi.fn()} />)
    await start()
    expect(await waitFor(() => screen.getByText('Rechazado'))).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pedir otro código', hidden: true })).toBeInTheDocument()
    const count = requests.length
    await act(() => vi.advanceTimersByTimeAsync(80))
    expect(requests).toHaveLength(count)
    await user.click(screen.getByRole('button', { name: 'Pedir otro código', hidden: true }))
    await waitFor(() => expect(requests.length).toBeGreaterThan(count))
  })

  it('shows the outside-network state and password fallback', async () => {
    fakeHttp({ '/api/sign-in-code': { status: 403, body: { detail: 'outside-network' } } })
    withData(<SignIn onSignedIn={vi.fn()} />)
    await start()
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Solo desde casa o la VPN', hidden: true }))).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Entrar con contraseña', hidden: true }))
    expect(screen.getByLabelText('Contraseña')).toBeInTheDocument()
  })

  it('explains rate limits inline', async () => {
    fakeHttp({ '/api/sign-in-code': { status: 429 } })
    withData(<SignIn onSignedIn={vi.fn()} />)
    await start()
    expect(await waitFor(() => screen.getByRole('alert', { hidden: true }))).toHaveTextContent('Demasiados códigos. Espera un minuto.')
  })
})
