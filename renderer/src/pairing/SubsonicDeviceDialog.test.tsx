import { installTestClock, clockUser, waitForClock as waitFor } from '../test/test-clock'
import { useState } from 'react'
import { act, render, screen, within } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import { installFakeSettings, type FakeSettings, type RecordedRequest, type ResponseSpec } from '../settings/test-support'
import { SubsonicDeviceDialog } from './SubsonicDeviceDialog'

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


const KEY = 'a-long-random-api-key-that-is-only-shown-once'
const PASSWORD = 'abcd-efgh-jkmn-pqrs'
const BASE = { id: 'd3', label: 'Symfonium', createdAt: new Date().toISOString(), lastSeenAt: null, isCurrent: false, credentialType: 'api-key' }
let fake: FakeSettings | undefined
afterEach(async () => { fake?.restore(); await i18n.changeLanguage('es') })

function open({ respond, hold = false }: {
  respond?: (request: RecordedRequest) => ResponseSpec | undefined
  hold?: boolean
} = {}) {
  fake = installFakeSettings({ respond: request => respond?.(request) ?? (request.method === 'GET'
    ? { status: 200, json: { devices: [BASE] } }
    : { status: 201, json: { device: BASE, token: request.pathname.endsWith('/api-key') ? KEY : PASSWORD } }) })
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const fetch = globalThis.fetch
  if (hold) globalThis.fetch = (async (request: Request) => { await gate; return fetch(request) }) as typeof globalThis.fetch
  const onAdded = vi.fn()
  const onClose = vi.fn()
  function Harness() {
    const [show, setShow] = useState(true)
    return show
      ? <SubsonicDeviceDialog serverUrl="http://192.0.2.20:8000/rest" username="ana" onAdded={onAdded} onClose={() => { onClose(); setShow(false) }} />
      : <button onClick={() => setShow(true)}>Reabrir</button>
  }
  return { ...render(<Harness />), onAdded, onClose, release }
}

describe('app-first Subsonic pairing', () => {
  it.each([
    ['Symfonium', 'api-key'], ['Crossonic', 'api-key'], ['Nautiline', 'api-key'],
    ['Amperfy', 'app-password'], ['substreamer', 'app-password'], ['Feishin', 'app-password'], ['Supersonic', 'app-password'],
    ['Tempus', 'app-password'], ['Otra app', 'app-password'],
  ])('%s selects %s and prefills an editable name', async (name, mechanism) => {
    open()
    expect(within(screen.getByRole('radiogroup', { name: 'Tu app' })).getAllByRole('radio')).toHaveLength(9)
    await user.click(screen.getByRole('radio', { name }))
    expect(screen.getByRole('textbox')).toHaveValue(name === 'Otra app' ? '' : name)
    expect(screen.getByText(mechanism === 'api-key' ? 'Clave de API' : 'Contraseña de app')).toHaveAttribute('title')
    expect(screen.queryByText('Preferida')).not.toBeInTheDocument()
    if (name === 'Otra app') await user.type(screen.getByRole('textbox'), 'Mi app')
    await user.click(screen.getByRole('button', { name: 'Crear' }))
    expect(await waitFor(() => screen.getByText(mechanism === 'api-key' ? KEY : PASSWORD))).toBeVisible()
    expect(fake!.requests.find(request => request.method === 'POST')?.pathname).toBe(`/api/me/devices/${mechanism}`)
    expect(screen.queryByText('ana') !== null).toBe(mechanism === 'app-password')
  })

  it('supports roving app tiles, arrows, Home and End, plus manual override', async () => {
    open()
    await user.click(screen.getByRole('radio', { name: 'Symfonium' }))
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Amperfy' })).toHaveFocus()
    expect(screen.getByRole('radio', { name: 'Symfonium' })).toHaveAttribute('tabindex', '-1')
    await user.keyboard('{End}')
    expect(screen.getByRole('radio', { name: 'Otra app' })).toHaveFocus()
    await user.keyboard('{Home}')
    expect(screen.getByRole('radio', { name: 'Symfonium' })).toHaveFocus()
    await user.click(screen.getByRole('button', { name: 'Elegir el tipo' }))
    await user.click(screen.getByRole('radio', { name: 'Contraseña de app' }))
    await user.click(screen.getByRole('button', { name: 'Crear' }))
    expect(await waitFor(() => screen.getByText(PASSWORD))).toBeVisible()
  })

  it('shows saved credentials once with individual copy, then waits and forgets on close', async () => {
    const user = clockUser()
    const { onAdded, onClose } = open()
    const write = vi.spyOn(navigator.clipboard, 'writeText')
    await user.click(screen.getByRole('button', { name: 'Crear' }))
    expect(await waitFor(() => screen.getByText(KEY))).toBeVisible()
    expect(screen.getByText('http://192.0.2.20:8000')).toBeVisible()
    expect(screen.getByText('No se vuelve a mostrar')).toBeVisible()
    expect(screen.getByText('ya guardada en el nido')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Copiar la clave de API' }))
    expect(write).toHaveBeenCalledWith(KEY)
    await user.click(screen.getByRole('button', { name: 'Listo' }))
    expect(screen.getByText('Esperando a Symfonium')).toBeVisible()
    expect(screen.queryByText(KEY)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /^Cerrar$/ }))
    expect(onClose).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'Reabrir' }))
    expect(screen.queryByText(KEY)).not.toBeInTheDocument()
    expect(onAdded).toHaveBeenCalledOnce()
    expect(fake!.requests.filter(request => request.method === 'POST')).toHaveLength(1)
    write.mockRestore()
  })

  it('polls waiting → wrong mechanism → connected, shows client names and revokes only that row', async () => {
    let status = 'waiting'
    const { onAdded, onClose } = open({ respond: request => {
      if (request.method === 'DELETE') return { status: 200, json: { signedOutThisDevice: false } }
      if (request.method !== 'GET') return undefined
      const stamp = new Date(Date.now() - 2000).toISOString()
      return { status: 200, json: { devices: [
        { ...BASE, lastSubsonicFailure: status === 'wrong' ? 'wrong-mechanism' : null, lastSubsonicFailureAt: stamp,
          firstSubsonicRequestAt: status === 'connected' ? stamp : null,
          lastSubsonicRequestAt: status === 'connected' ? stamp : null, subsonicClientName: 'Symfonium 13.2 · Pixel 8' },
        { ...BASE, id: 'other', label: 'Feishin', credentialType: 'app-password' },
      ] } }
    } })
    await user.click(screen.getByRole('button', { name: 'Crear' }))
    await waitFor(() => screen.getByText(KEY))
    await user.click(screen.getByRole('button', { name: 'Listo' }))
    expect(screen.getByText('Esperando a Symfonium')).toBeVisible()
    status = 'wrong'
    // Each device connection check runs on the two-second polling clock.
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(await waitFor(() => screen.getByText('Symfonium intentó entrar sin la clave', {}))).toHaveAttribute('title', expect.stringContaining('token'))
    status = 'connected'
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(await waitFor(() => screen.getByText('Conectada', {}))).toBeVisible()
    expect(screen.getByText('Symfonium 13.2 · Pixel 8')).toBeVisible()
    expect(screen.getByText('sin uso')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Quitar Feishin' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Quitar Feishin' })).not.toBeInTheDocument())
    expect(fake!.requests.filter(request => request.method === 'DELETE').map(request => request.pathname)).toEqual(['/api/me/devices/other'])
    onAdded.mockClear()
    await user.click(screen.getByRole('button', { name: 'Listo' }))
    expect(onAdded).toHaveBeenCalledOnce() // My account refreshes with the observed connection
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('locks minting and dismissal while busy and allows retry after a failed mint', async () => {
    const { onClose, release } = open({ hold: true })
    await user.click(screen.getByRole('button', { name: 'Crear' }))
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled()
    await user.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => release())
    expect(await waitFor(() => screen.getByText(KEY))).toBeVisible()
  })

  it('shows a mint failure and retries', async () => {
    let failing = true
    open({ respond: request => request.method === 'POST' && failing ? { status: 500 } : undefined })
    await user.click(screen.getByRole('button', { name: 'Crear' }))
    expect(await waitFor(() => screen.getByRole('alert'))).toHaveTextContent('No se pudo crear la clave de API')
    failing = false
    await user.click(screen.getByRole('button', { name: 'Crear' }))
    expect(await waitFor(() => screen.getByText(KEY))).toBeVisible()
  })

  it('uses handwritten English translations', async () => {
    await i18n.changeLanguage('en')
    open()
    expect(screen.getByRole('dialog', { name: 'Add a music app' })).toBeVisible()
    await user.click(screen.getByRole('radio', { name: 'Other app' }))
    expect(screen.getByText('App password')).toBeVisible()
    expect(screen.getByText('Sign in with')).toBeVisible()
    await user.click(screen.getByRole('radio', { name: 'substreamer' }))
    expect(screen.getByRole('radio', { name: 'substreamer' })).toHaveTextContent('Multiple')
    await user.click(screen.getByRole('button', { name: 'Create' }))
    expect(await waitFor(() => screen.getByText('Enter these in substreamer → Server URL, Username and Password'))).toBeVisible()
  })
})
