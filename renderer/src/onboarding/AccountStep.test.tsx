import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DataProvider } from '../data'
import { installFakeSettings, serverStatus, type FakeSettings } from '../settings/test-support'
import { bridge, setFakeBridgeForTest } from '../bridge'
import { AccountStep } from './AccountStep'

let fake: FakeSettings | undefined
let restoreAuth: (() => void) | undefined
afterEach(() => { restoreAuth?.(); restoreAuth = undefined; fake?.restore(); fake = undefined })

function mount(props: Partial<React.ComponentProps<typeof AccountStep>> = {}) {
  const base = bridge()
  restoreAuth = setFakeBridgeForTest({ ...base, invoke: async (channel: string, request: unknown) => {
    if (channel === 'auth:set') { fake!.invocations.push({ channel, request }); return { ok: true, persisted: true } }
    return base.invoke(channel as never, request as never)
  } } as typeof base)
  return render(<DataProvider><AccountStep nestName="Nido" host={null} onCreated={vi.fn()} {...props} /></DataProvider>)
}

async function credentials() {
  await userEvent.type(screen.getByLabelText('Usuario'), 'robin')
  await userEvent.type(screen.getByLabelText('Contraseña'), 'una-contra-larga')
  await userEvent.type(screen.getByLabelText('Confirmar contraseña'), 'una-contra-larga')
}

describe('the account step', () => {
  it('draws the live username, initial, owner, nest and device', async () => {
    fake = installFakeSettings({ deviceName: 'MacBook Pro' })
    const { container } = mount()
    await userEvent.type(screen.getByLabelText('Usuario'), 'jose')
    const card = container.querySelector('.kob-account-card') as HTMLElement
    expect(card.querySelector('.kob-account-card__initial')).toHaveTextContent('J')
    expect(within(card).getByText('jose')).toBeInTheDocument()
    expect(within(card).getByText('Admin')).toHaveAttribute('title')
    expect(within(card).getByText('MacBook Pro')).toBeInTheDocument()
    expect(card.querySelector('dd')).toHaveTextContent('Nido')
  })

  it('claims with the local setup token and stores it without ever sending nestName', async () => {
    fake = installFakeSettings({ status: serverStatus({ mode: 'child' }), localSetupToken: 'setup-secret', deviceName: 'MacBook Pro', respond: request => request.pathname === '/api/claim' ? { status: 201, json: { token: 'claim-token' } } : undefined })
    const onCreated = vi.fn()
    mount({ setupTokenRequired: true, localNest: true, onCreated })
    await credentials()
    expect(screen.queryByLabelText('Código de instalación')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Crear cuenta' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('robin'))
    const claim = fake.requests.find(request => request.pathname === '/api/claim')!
    expect(claim.body).toEqual({ username: 'robin', label: 'robin', password: 'una-contra-larga', setupToken: 'setup-secret' })
    expect(fake.invocations.find(call => call.channel === 'auth:set')?.request).toEqual({ token: 'claim-token', label: 'MacBook Pro', role: 'owner' })
  })

  it('shows the setup code only when required on a remote nest', async () => {
    fake = installFakeSettings({ status: serverStatus({ mode: 'external' }), respond: request => request.pathname === '/api/claim' ? { status: 201, json: { token: 'claim-token' } } : undefined })
    const { unmount } = mount()
    await credentials()
    expect(screen.queryByLabelText('Código de instalación')).toBeNull()
    unmount()
    mount({ setupTokenRequired: true })
    const code = await screen.findByLabelText('Código de instalación')
    expect(code).toHaveClass('kob-input--mono', 'kob-setup-code')
    expect(screen.getByText('Código de instalación', { selector: 'label' })).toHaveAttribute('title', 'Lo muestra el instalador al terminar')
    await credentials()
    expect(screen.getByRole('button', { name: 'Crear cuenta' })).toBeDisabled()
    await userEvent.type(code, '  setup-code  ')
    await userEvent.click(screen.getByRole('button', { name: 'Crear cuenta' }))
    await waitFor(() => expect(fake!.requests.find(request => request.pathname === '/api/claim')?.body).toMatchObject({ setupToken: 'setup-code' }))
    expect(fake.invocations.some(call => call.channel === 'server:local-setup-token')).toBe(false)
  })

  it('keeps password validation and edits an existing account without claiming again', async () => {
    fake = installFakeSettings({ respond: request => request.pathname === '/api/me/username' ? { status: 200, json: { username: 'nuevo' } } : undefined })
    const { unmount } = mount()
    await userEvent.type(screen.getByLabelText('Usuario'), 'robin')
    await userEvent.type(screen.getByLabelText('Contraseña'), 'corta')
    expect(screen.getByRole('button', { name: 'Crear cuenta' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Al menos 10 caracteres.')
    await userEvent.type(screen.getByLabelText('Confirmar contraseña'), 'otra')
    expect(screen.getByText('Las dos contraseñas no coinciden.')).toBeInTheDocument()
    unmount()
    const onCreated = vi.fn()
    mount({ existingUsername: 'robin', onCreated })
    expect(screen.queryByLabelText('Contraseña')).toBeNull()
    await userEvent.clear(screen.getByLabelText('Usuario'))
    await userEvent.type(screen.getByLabelText('Usuario'), 'nuevo')
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('nuevo'))
    expect(fake.requests.some(request => request.pathname === '/api/claim')).toBe(false)
  })
})
