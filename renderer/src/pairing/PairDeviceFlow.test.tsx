/** Verify that minted credentials remain visible until explicit capture confirmation. */

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'

import { PairDeviceFlow } from './PairDeviceFlow'
import { PairingProvider } from './PairingProvider'
import { createPairingGateway } from './gateway'
import { createApiClient } from '../api/client'
import { installFakeBackend } from './fakeBackend'
import type { FakeBackend, FakeBackendOptions } from './fakeBackend'

const TOKEN = 'r4nd0m-t0ken_value'

function mount(children: ReactNode, backend: FakeBackend, copyText = vi.fn(async () => true)) {
  const gateway = createPairingGateway(createApiClient(backend.origin))
  return {
    copyText,
    ...render(
      <PairingProvider gateway={gateway} serverUrl={backend.origin} copyText={copyText}>
        {children}
      </PairingProvider>,
    ),
  }
}

function start(options: FakeBackendOptions = {}) {
  const backend = installFakeBackend({ mintedToken: TOKEN, ...options })
  const onFinished = vi.fn()
  const onCancel = vi.fn()
  const rendered = mount(
    <PairDeviceFlow onFinished={onFinished} onCancel={onCancel} />,
    backend,
  )
  return { backend, onFinished, onCancel, ...rendered }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PairDeviceFlow', () => {
  it('defaults to the least dangerous role and says what each one means', () => {
    start()

    const member = screen.getByRole('radio', { name: /Normal/ }) as HTMLInputElement
    const owner = screen.getByRole('radio', { name: /Admin/ }) as HTMLInputElement

    // A phone paired as owner can revoke the owner's own access. The
    // default is the one that cannot, and both options state their consequence
    // rather than relying on the word.
    expect(member.checked).toBe(true)
    expect(owner.checked).toBe(false)
    expect(screen.getByText(/No puede vincular ni quitar dispositivos/)).toBeTruthy()
    expect(screen.getByText(/Puede vincular y quitar dispositivos/)).toBeTruthy()
  })

  it('mints as a member and shows the token exactly once, behind a deliberate dismissal', async () => {
    const user = userEvent.setup()
    const { backend, onFinished } = start()

    await user.type(screen.getByLabelText('Nombre del dispositivo'), 'iPhone de Robin')
    await user.click(screen.getByRole('button', { name: 'Crear acceso' }))

    const mint = backend.requests.find((r) => r.method === 'POST')
    expect(mint?.url).toBe(`${backend.origin}/api/users`)
    expect(mint?.body).toEqual({ label: 'iPhone de Robin', role: 'member' })

    const field = (await screen.findByLabelText('Token de acceso')) as HTMLInputElement
    expect(field.value).toBe(TOKEN)
    expect(field.readOnly).toBe(true)
    expect(screen.getByText(/una sola vez/)).toBeTruthy()

    // The full payload is a credential and must never be loose in the tree.
    expect(document.body.innerHTML).not.toContain('krobi://')
    // The token lives in a field, not in prose that a screenshot would carry.
    expect(document.body.textContent).not.toContain(TOKEN)

    // No escape hatch: the reveal offers no cancel and no close, and the one way
    // out is disabled until the person says they captured it.
    expect(screen.queryByRole('button', { name: 'Cancelar' })).toBeNull()
    const done = screen.getByRole('button', { name: 'Listo' }) as HTMLButtonElement
    expect(done.disabled).toBe(true)
    expect(onFinished).not.toHaveBeenCalled()

    await user.click(screen.getByLabelText('Ya escaneé el código o guardé el token'))
    expect(done.disabled).toBe(false)
    await user.click(done)

    expect(onFinished).toHaveBeenCalledTimes(1)
    expect(onFinished.mock.calls[0]?.[0]).toMatchObject({ label: 'iPhone de Robin', role: 'member' })
    // And it is gone from the tree the moment it is dismissed.
    expect(screen.queryByLabelText('Token de acceso')).toBeNull()
    expect(document.body.innerHTML).not.toContain(TOKEN)
  })

  it('draws a scannable code for the minted token', async () => {
    const user = userEvent.setup()
    const { backend } = start()

    await user.type(screen.getByLabelText('Nombre del dispositivo'), 'Tablet')
    await user.click(screen.getByRole('button', { name: 'Crear acceso' }))

    await screen.findByLabelText('Token de acceso')
    expect(screen.getByRole('img', { name: /Código QR/ })).toBeTruthy()
    expect(screen.getByLabelText('Dirección del nido')).toHaveProperty('value', backend.origin)
  })

  it('sends owner only when owner was chosen on purpose', async () => {
    const user = userEvent.setup()
    const { backend } = start()

    await user.type(screen.getByLabelText('Nombre del dispositivo'), 'Mi portátil')
    await user.click(screen.getByRole('radio', { name: /Admin/ }))
    await user.click(screen.getByRole('button', { name: 'Crear acceso' }))

    await screen.findByLabelText('Token de acceso')
    expect(backend.requests.find((r) => r.method === 'POST')?.body).toEqual({
      label: 'Mi portátil',
      role: 'owner',
    })
  })

  it('copies the token through the injected copier without printing it', async () => {
    const user = userEvent.setup()
    const { copyText } = start()

    await user.type(screen.getByLabelText('Nombre del dispositivo'), 'iPhone')
    await user.click(screen.getByRole('button', { name: 'Crear acceso' }))
    await screen.findByLabelText('Token de acceso')
    await user.click(screen.getByRole('button', { name: 'Copiar token' }))

    expect(copyText).toHaveBeenCalledWith(TOKEN)
    // The confirmation says it worked and does not quote what was copied.
    const said = await screen.findByText('Copiado al portapapeles.')
    expect(said.textContent).not.toContain(TOKEN)
  })

  it('explains a refused mint and reveals nothing', async () => {
    const user = userEvent.setup()
    start({ callerIsOwner: false })

    await user.type(screen.getByLabelText('Nombre del dispositivo'), 'iPhone')
    await user.click(screen.getByRole('button', { name: 'Crear acceso' }))

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Solo una cuenta admin puede vincular dispositivos.',
    )
    expect(screen.queryByLabelText('Token de acceso')).toBeNull()
  })

  it('cancels only before a token exists', async () => {
    const user = userEvent.setup()
    const { onCancel } = start()

    await user.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
