/** Keep refused device listings distinct from empty lists. */

import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PairingPanel } from './PairingPanel'
import { PairingProvider } from './PairingProvider'
import { createPairingGateway } from './gateway'
import { createApiClient } from '../api/client'
import { installFakeBackend } from './fakeBackend'
import type { FakeBackendOptions } from './fakeBackend'
import type { PairedDevice } from './types'

const PHONE: PairedDevice = {
  id: 'u-phone',
  label: 'iPhone de Robin',
  role: 'member',
  createdAt: '2026-08-20T11:02:31Z',
  lastSeenAt: '2026-08-20T11:40:07Z',
}

const LAPTOP: PairedDevice = {
  id: 'u-laptop',
  label: 'Portátil',
  role: 'owner',
  createdAt: '2026-08-01T09:00:00Z',
  lastSeenAt: null,
}

function start(options: FakeBackendOptions = {}) {
  const backend = installFakeBackend({ mintedToken: 'r4nd0m-t0ken_value', ...options })
  const gateway = createPairingGateway(createApiClient(backend.origin))
  return {
    backend,
    ...render(
      <PairingProvider gateway={gateway} serverUrl={backend.origin} copyText={vi.fn(async () => true)}>
        <PairingPanel />
      </PairingProvider>,
    ),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PairingPanel', () => {
  it('lists every device with its role and its last connection', async () => {
    start({ users: [PHONE, LAPTOP] })

    const phoneRow = (await screen.findByRole('rowheader', { name: 'iPhone de Robin' }))
      .parentElement as HTMLElement
    expect(within(phoneRow).getByText('Normal')).toBeTruthy()

    const laptopRow = screen.getByRole('rowheader', { name: 'Portátil' }).parentElement as HTMLElement
    expect(within(laptopRow).getByText('Admin')).toBeTruthy()
    // A device that has never called has no lastSeenAt, and "Never" is the
    // honest rendering of that; a dash would read as missing data.
    expect(within(laptopRow).getByText('Nunca')).toBeTruthy()
  })

  it('says an empty table is empty rather than leaving nothing on screen', async () => {
    start({ users: [] })
    expect(await screen.findByText('Todavía no hay dispositivos vinculados.')).toBeTruthy()
  })

  it('explains the refusal a member token gets instead of drawing an empty list', async () => {
    const { backend } = start({ users: [PHONE], callerIsOwner: false })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Solo una cuenta admin puede ver y administrar los dispositivos')

    // Nothing is claimed about who has access, and the actions that would also
    // be refused are not offered.
    expect(screen.queryByText('Todavía no hay dispositivos vinculados.')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Vincular un dispositivo' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reintentar' })).toBeNull()
    expect(backend.requests).toHaveLength(1)
  })

  it('offers a retry for a server it could not reach', async () => {
    const user = userEvent.setup()
    const { backend } = start({ failWith: 500 })

    await user.click(await screen.findByRole('button', { name: 'Reintentar' }))
    await waitFor(() => expect(backend.requests.length).toBe(2))
  })

  it('asks before revoking, and names the consequence', async () => {
    const user = userEvent.setup()
    const { backend } = start({ users: [PHONE] })

    await user.click(await screen.findByRole('button', { name: 'Quitar acceso a «iPhone de Robin»' }))

    // Asking is not sending: no request has left yet.
    expect(backend.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
    const asked = screen.getByRole('alert')
    expect(asked.textContent).toContain('«iPhone de Robin»')
    expect(asked.textContent).toContain('dejará de funcionar de inmediato')

    await user.click(screen.getByRole('button', { name: 'Cancelar' }))
    expect(backend.requests.filter((r) => r.method === 'DELETE')).toHaveLength(0)
    expect(screen.getByRole('rowheader', { name: 'iPhone de Robin' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Quitar acceso a «iPhone de Robin»' }))
    await user.click(screen.getByRole('button', { name: 'Quitar acceso' }))

    await waitFor(() =>
      expect(backend.requests.filter((r) => r.method === 'DELETE')[0]?.url).toBe(
        `${backend.origin}/api/users/u-phone`,
      ),
    )
    await waitFor(() =>
      expect(screen.queryByRole('rowheader', { name: 'iPhone de Robin' })).toBeNull(),
    )
  })

  it('keeps the last owner on the server and says why in the row', async () => {
    const user = userEvent.setup()
    // The server answers 422 rather than letting the last owner lock everybody
    // out of access management. 422 is also what a bad label gets, so this is
    // the assertion that the gateway named the two apart by call site.
    const { backend } = start({ users: [LAPTOP], lastOwnerIds: ['u-laptop'] })

    await user.click(await screen.findByRole('button', { name: 'Quitar acceso a «Portátil»' }))
    await user.click(screen.getByRole('button', { name: 'Quitar acceso' }))

    expect(await screen.findByText(/último admin/)).toBeTruthy()
    expect(backend.requests.filter((r) => r.method === 'DELETE')).toHaveLength(1)
    // The row is still there, because the device still has access.
    expect(screen.getByRole('rowheader', { name: 'Portátil' })).toBeTruthy()
  })

  it('pairs a device end to end and shows it in the list afterwards', async () => {
    const user = userEvent.setup()
    start({ users: [] })

    await user.click(await screen.findByRole('button', { name: 'Vincular un dispositivo' }))
    await user.type(screen.getByLabelText('Nombre del dispositivo'), 'iPad de la cocina')
    await user.click(screen.getByRole('button', { name: 'Crear acceso' }))

    await screen.findByLabelText('Token de acceso')
    await user.click(screen.getByLabelText('Ya escaneé el código o guardé el token'))
    await user.click(screen.getByRole('button', { name: 'Listo' }))

    expect(await screen.findByRole('rowheader', { name: 'iPad de la cocina' })).toBeTruthy()
    expect(screen.queryByLabelText('Token de acceso')).toBeNull()
    expect(document.body.innerHTML).not.toContain('r4nd0m-t0ken_value')
  })
})
