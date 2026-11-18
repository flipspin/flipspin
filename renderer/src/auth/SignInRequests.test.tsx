import { deliverChanges } from '../data/changeListeners'
import { StrictMode } from 'react'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SignInRequestsProvider } from './SignInRequestsProvider'
import { DataProvider, type CurrentUser } from '../data'
import { installFakeSettings, type FakeSettings } from '../settings/test-support'
import type { SignInRequest } from './signInRequests'

const me: CurrentUser = { id: 'u1', label: 'Ana', username: 'ana', role: 'member', source: 'token', isOwner: false, onboarded: true }
const row: SignInRequest = { id: 'r1', code: 'ABC234', deviceLabel: 'Safari en Mac', network: 'vpn', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() }
let fake: FakeSettings | null = null
afterEach(() => {
  fake?.restore()
  fake = null
  vi.useRealTimers()
  vi.restoreAllMocks()
  history.replaceState(null, '', '/')
})

function mount(account: CurrentUser = me) {
  return render(<DataProvider><SignInRequestsProvider me={account}><button>Biblioteca</button></SignInRequestsProvider></DataProvider>)
}

describe('sign-in requests', () => {
  it('shows account, device, network and matching code, and approves by scoped id', async () => {
    fake = installFakeSettings({ respond: r => {
      if (r.pathname === '/api/me/sign-in-requests') return { status: 200, json: { requests: [row] } }
      if (r.pathname === '/api/me/sign-in-requests/r1/approve') return { status: 200, json: { success: true } }
      return undefined
    } })
    mount()
    const sheet = await screen.findByRole('dialog', { name: 'quiere entrar' })
    expect(within(sheet).getByText(/VPN · hace \d+ s/)).toBeInTheDocument()
    expect(within(sheet).getByText('ana')).toBeInTheDocument()
    expect(within(sheet).getByText('ABC-234')).toBeInTheDocument()
    await userEvent.click(within(sheet).getByRole('button', { name: 'Aprobar' }))
    expect(await within(sheet).findByText('Safari en Mac conectado')).toBeInTheDocument()
    expect(fake.requests.some(r => r.pathname === '/api/me/sign-in-requests/r1/approve')).toBe(true)
  })

  it('declines and does not redisplay a dismissed request', async () => {
    fake = installFakeSettings({ respond: r => r.method === 'GET'
      ? { status: 200, json: { requests: [row] } } : { status: 200, json: { success: true } } })
    mount()
    await userEvent.click(await screen.findByRole('button', { name: 'Rechazar' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    act(() => { fake!.emitFocus(false); deliverChanges(new Set(['signin'])); fake!.emitFocus(true) })
    await waitFor(() => expect(fake!.requests.filter(r => r.method === 'GET')).toHaveLength(2))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(fake.requests.some(r => r.pathname === '/api/me/sign-in-requests/r1/decline')).toBe(true)
  })

  it('uses sign-in changes only while focused and catches up once on focus', async () => {
    vi.useFakeTimers()
    fake = installFakeSettings({ respond: () => ({ status: 200, json: { requests: [] } }) })
    const view = mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fake.requests).toHaveLength(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fake.requests).toHaveLength(1)
    act(() => deliverChanges(new Set(['signin'])))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fake.requests).toHaveLength(2)
    act(() => { fake!.emitFocus(false); deliverChanges(new Set(['signin'])); deliverChanges(new Set(['signin'])) })
    await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
    window.dispatchEvent(new Event('focus'))
    expect(fake.requests).toHaveLength(2)

    await act(async () => { fake!.emitFocus(true); await vi.advanceTimersByTimeAsync(0) })
    expect(fake.requests).toHaveLength(3)
    view.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(fake.requests).toHaveLength(3)
  })

  it.each(['local', 'shared-secret', 'anonymous'])('never polls for a %s principal', async source => {
    fake = installFakeSettings()
    mount({ ...me, source })
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(fake.requests).toHaveLength(0)
  })

  it('keeps a failed decision on the sheet and allows retry', async () => {
    fake = installFakeSettings({ respond: r => r.method === 'GET' ? { status: 200, json: { requests: [row] } } : { status: 404, json: { detail: 'gone' } } })
    mount()
    await userEvent.click(await screen.findByRole('button', { name: 'Aprobar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Código no disponible.')
    expect(screen.getByRole('button', { name: 'Aprobar' })).toBeEnabled()
  })
})
