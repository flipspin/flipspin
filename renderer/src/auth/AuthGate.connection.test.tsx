import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DataProvider } from '../data'
import { installFakeSettings, serverStatus, type FakeSettings } from '../settings/test-support'
import type { ServerConnection } from '../lib/ipc'
import { AuthGate } from './AuthGate'

const status = (state: ServerConnection['state']) => serverStatus({ connection: { state, since: 0, attempt: 1, lastError: null, checks: [] } })
let fake: FakeSettings
afterEach(() => fake?.restore())
const renderGate = () => render(<DataProvider><AuthGate serverIsInit><p>La biblioteca</p></AuthGate></DataProvider>)

describe('session check follows the shell', () => {
  it('waits for connected, keeps a network failure as unknown, and checks again on return', async () => {
    let fail = true
    fake = installFakeSettings({ status: status('connecting'), respond: () => fail ? { networkError: 'No route to host' } : { status: 200, json: { id: 'u1', source: 'local' } } })
    renderGate()
    await act(async () => {})
    expect(fake.requests).toHaveLength(0)
    act(() => fake.emitServerStatus(status('connected')))
    await waitFor(() => expect(fake.requests.filter(r => r.pathname === '/api/me')).toHaveLength(1))
    await act(async () => {})
    expect(screen.queryByText(/No se pudo comprobar tu sesión/)).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Iniciar sesión' })).not.toBeInTheDocument()
    expect(fake.invokedWith('server:report-auth')).toHaveLength(0)
    act(() => fake.emitServerStatus(status('unreachable')))
    expect(screen.queryByText(/No se pudo comprobar tu sesión/)).not.toBeInTheDocument()
    fail = false
    act(() => fake.emitServerStatus(status('connected')))
    expect(await screen.findByText('La biblioteca')).toBeInTheDocument()
    // A blip after sign-in preserves the mounted app.
    act(() => fake.emitServerStatus(status('connecting')))
    expect(screen.getByText('La biblioteca')).toBeInTheDocument()
  })

  it.each([401, 403] as const)('reports only an auth refusal (%s), then shows sign-in without retry', async code => {
    fake = installFakeSettings({ respond: () => ({ status: code }) })
    renderGate()
    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument()
    expect(fake.invokedWith('server:report-auth')).toEqual([{ status: code }])
    expect(fake.requests.filter(r => r.pathname === '/api/me')).toHaveLength(1)
    expect(fake.invokedWith('server:retry-now')).toHaveLength(0)
    expect(screen.queryByText(/No se pudo comprobar tu sesión|Sin conexión/)).not.toBeInTheDocument()
  })

  it('shows sign-in immediately on needs-auth without a session request or handshake', async () => {
    fake = installFakeSettings({ status: status('needs-auth') })
    renderGate()
    expect(await screen.findByRole('heading', { name: 'Iniciar sesión' })).toBeInTheDocument()
    expect(fake.requests.filter(r => r.pathname === '/api/me')).toHaveLength(0)
    expect(fake.invokedWith('server:probe')).toHaveLength(0)
    expect(fake.invokedWith('server:retry-now')).toHaveLength(0)
  })
})
