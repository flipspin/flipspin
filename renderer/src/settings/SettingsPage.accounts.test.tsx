import { installTestClock, clockUser, waitForClock as waitFor } from '../test/test-clock'
import { screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import i18n from '../i18n'
import { ME_ADMIN, ME_NORMAL, USERS, fake, nav, renderPage } from './page-test-support'

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


describe('account screens', () => {
  it.each([ME_ADMIN, ME_NORMAL])('lists My devices immediately after My account for $role', async me => {
    renderPage({ me })
    const menu = await waitFor(() => within(nav()).getByRole('button', { name: 'Mis dispositivos' }))
    const names = within(nav()).getAllByRole('button').map(button => button.textContent)
    expect(names[names.indexOf('Mi cuenta') + 1]).toBe('Mis dispositivos')
    expect(menu.previousElementSibling).toHaveTextContent('Mi cuenta')
    const index = within(document.querySelector<HTMLElement>('.settings-index')!)
    await user.click(index.getByRole('button', { name: /^Mis dispositivos/ }))
    expect(document.querySelector('.settings')).toHaveAttribute('data-page', 'dispositivos')
  })

  it.each([
    { section: 'cuenta', me: ME_ADMIN, role: 'Admin' },
    { section: 'dispositivos', me: ME_ADMIN, role: 'Admin' },
    { section: 'cuenta', me: ME_NORMAL, role: 'Normal' },
    { section: 'dispositivos', me: ME_NORMAL, role: 'Normal' },
  ])('$section opens with the $role account label, username and role', async ({ section, me, role }) => {
    renderPage({ section, me })
    const label = await waitFor(() => screen.getByText(me.label, { selector: '.settings-me__name' }))
    expect(label.closest('.settings-me')).toHaveTextContent(`@${me.username} · ${role}`)
    expect(label.closest('.settings-page')?.querySelector('.settings-h')?.nextElementSibling).toBe(label.closest('.settings-me'))
  })

  it.each(['cuenta', 'dispositivos'])('%s translates the account header and new screen title', async section => {
    await i18n.changeLanguage('en')
    renderPage({ section })
    const label = await waitFor(() => screen.getByText(ME_ADMIN.label, { selector: '.settings-me__name' }))
    expect(label.closest('.settings-me')).toHaveTextContent(`@${ME_ADMIN.username} · Admin`)
    expect(screen.getByRole('heading', { name: section === 'cuenta' ? 'My account' : 'My devices' })).toBeVisible()
  })

  it.each(['cuenta', 'dispositivos'])('%s names a sentinel with a muted word and reason', async section => {
    renderPage({ section, me: { ...ME_ADMIN, id: 'local', label: 'Sentinel', source: 'local', username: undefined } })
    const missing = await waitFor(() => screen.getByText('Sin cuenta', { exact: false, selector: '.settings-me .k-missing' }))
    expect(missing).toHaveAttribute('title', 'Esta credencial no tiene una cuenta propia en este nido.')
    expect(screen.queryByText('Sentinel')).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Dispositivos' })).not.toBeInTheDocument()
  })

  it.each(['cuenta', 'dispositivos'])('%s handles the sentinel HTTP response', async section => {
    renderPage({ section, respond: r => r.pathname === '/api/me' ? { status: 409, json: { detail: 'account-required' } } : undefined })
    expect(await waitFor(() => screen.getByText('Sin cuenta', { exact: false, selector: '.settings-me .k-missing' }))).toHaveAttribute('title', 'Esta credencial no tiene una cuenta propia en este nido.')
    expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument()
  })

  it('keeps account actions on My account and moves both lists to My devices', async () => {
    const { fake } = renderPage({ section: 'cuenta' })
    await waitFor(() => screen.getByRole('button', { name: 'Cambiar la contraseña' }))
    expect(screen.getByRole('button', { name: 'Cambiar el nombre' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Eliminar' })).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'Dispositivos' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Apps de música' })).not.toBeInTheDocument()
    expect(fake.requests.some(r => r.pathname === '/api/me/devices')).toBe(false)
    await user.click(within(nav()).getByRole('button', { name: 'Mis dispositivos' }))
    const devices = await waitFor(() => screen.getByRole('heading', { name: 'Dispositivos' }))
    const apps = screen.getByRole('heading', { name: 'Apps de música' })
    expect(devices.compareDocumentPosition(apps) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Agregar una app de música' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Cambiar la contraseña' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Eliminar' })).not.toBeInTheDocument()
  })

  it('keeps music credentials in the music apps list', async () => {
    renderPage({ section: 'dispositivos', respond: r => r.pathname === '/api/me/devices' ? { status: 200, json: { devices: [
      { id: 'session', label: 'Equipo de prueba', isCurrent: true },
      { id: 'app-password', label: 'App con contraseña', isCurrent: false, credentialType: 'app-password' },
      { id: 'api-key', label: 'App con clave', isCurrent: false, credentialType: 'api-key' },
    ] } } : undefined })
    const current = await waitFor(() => screen.getByText('Equipo de prueba'))
    expect(current.closest('.settings-dev')).toHaveTextContent('este equipo')
    expect(screen.getAllByText('App con contraseña')).toHaveLength(1)
    expect(screen.getAllByText('App con clave')).toHaveLength(1)
    expect(screen.getByText('App con clave').closest('.settings-block')).toHaveTextContent('Apps de música')
  })

  it('opens the existing self-deletion dialog from My account', async () => {
    const { fake } = renderPage({ section: 'cuenta' })
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Eliminar' })))
    expect(await waitFor(() => screen.getByRole('dialog', { name: '¿Eliminar tu cuenta?' }))).toBeVisible()
    expect(fake.requests.some(r => r.method === 'DELETE')).toBe(false)
  })

  it('routes the phone pairing followup to My devices', async () => {
    renderPage({ navigation: true, followup: true })
    await user.click(await waitFor(() => screen.getByRole('button', { name: /Emparejar un teléfono/ })))
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Mis dispositivos' }))).toBeVisible()
  })

  it('opens My devices from an approved sign-in request', async () => {
    renderPage({ navigation: true, respond: r => {
      if (r.pathname === '/api/me/sign-in-requests') return { status: 200, json: { requests: [{ id: 'request-demo', code: 'ABC234', deviceLabel: 'Equipo de prueba', network: 'local', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() }] } }
      if (r.pathname.endsWith('/approve')) return { status: 200, json: { success: true } }
      return undefined
    } })
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Aprobar' })))
    const sheet = await waitFor(() => screen.getByRole('dialog', { name: 'Equipo de prueba conectado' }))
    await user.click(within(sheet).getByRole('button', { name: 'Mis dispositivos' }))
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Mis dispositivos' }))).toBeVisible()
    expect(sheet).not.toBeInTheDocument()
  })
})

describe('SettingsPage', () => {
  it('fetches account devices only after unfolding and uses their real count', async () => {
    const { fake } = renderPage({ section: 'cuentas', respond: r => r.pathname === '/api/users/u2/devices'
      ? { status: 200, json: { devices: [{ id: 'member-phone', label: 'Teléfono de Member', lastSeenAt: null, isCurrent: false, createdAt: null }] } } : undefined })
    const name = await waitFor(() => screen.getByText('Member', { selector: 'b' }))
    const row = name.closest('details')!
    expect(row.querySelector('summary')).not.toHaveTextContent('dispositivos')
    expect(row.querySelector('summary')).not.toHaveTextContent('—')
    expect(fake.requests.some(r => /^\/api\/users\/[^/]+\/devices$/.test(r.pathname))).toBe(false)
    await user.click(name)
    expect(await waitFor(() => within(row).getByText(/Teléfono de Member/))).toBeInTheDocument()
    expect(within(row).getByText(/1 dispositivo/)).toBeInTheDocument()
    expect(fake.requests.filter(r => r.pathname === '/api/users/u2/devices')).toHaveLength(1)
  })

  it('«Cuentas»: the list, opened in place to its devices', async () => {
    renderPage({
      section: 'cuentas',
      respond: (r) => (r.pathname === '/api/users/u2/devices' ? { status: 200, json: { devices: [{ id: 'x', label: 'Pixel de Member', createdAt: null, lastSeenAt: null, isCurrent: false }] } } : undefined),
    })
    expect(await waitFor(() => screen.getByText('Member', { selector: 'b' }))).toBeInTheDocument()
    expect(screen.getByText('tú')).toBeInTheDocument()
    await user.click(screen.getByText('Member', { selector: 'b' }))
    expect(await waitFor(() => screen.getByText(/Pixel de Member/))).toBeInTheDocument()
  })

  it('«Cuentas» loading, error and retry', async () => {
    let fail = true
    renderPage({ section: 'cuentas', respond: (r) => (r.pathname === '/api/users' && fail ? { status: 500, json: { detail: 'boom' } } : undefined) })
    expect(await waitFor(() => screen.getByRole('status', { name: 'Cargando las cuentas' }))).toBeInTheDocument()
    expect(await waitFor(() => screen.getByText('No se pudo cargar las cuentas.'))).toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(await waitFor(() => screen.getByText('Owner'))).toBeInTheDocument()
  })

  it('«Cuentas» with only yours', async () => {
    renderPage({ section: 'cuentas', respond: (r) => (r.pathname === '/api/users' ? { status: 200, json: { users: [USERS[0]] } } : undefined) })
    expect(await waitFor(() => screen.getByTitle('Solo está tu cuenta.'))).toBeInTheDocument()
    expect(screen.queryByText('Solo está tu cuenta.')).not.toBeInTheDocument()
  })

  it('reopens deletion on account only with a new preview; deletion closes and refreshes the account list', async () => {
    let removed = false
    const { onClose, fake } = renderPage({ section: 'cuentas', respond: r => {
      if (r.pathname.endsWith('/deletion-preview')) return { status: 200, json: { devices: 2, songs: 212, playlists: 3, removable: { count: 38, bytes: 1234567890 }, kept: 174 } }
      if (r.method === 'DELETE') {
        removed = true
        return { status: 200, json: { success: true, user: USERS[1], removedSongs: 38, freedBytes: 1234567890, playlists: 'deleted' } }
      }
      if (r.pathname === '/api/users') return { status: 200, json: { users: removed ? [USERS[0]] : USERS } }
      return undefined
    } })
    await user.click(await waitFor(() => screen.getByText('Member', { selector: 'b' })))
    const row = screen.getByText('Member', { selector: 'b' }).closest('details')!
    await user.click(within(row).getByRole('button', { name: 'Eliminar' }))
    const songOption = () => screen.getByRole('radio', { name: /La cuenta y sus canciones/ })
    await waitFor(() => expect(songOption()).toBeEnabled())
    await user.click(songOption())
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    await user.click(within(row).getByRole('button', { name: 'Eliminar' }))
    await waitFor(() => expect(songOption()).toBeEnabled())
    expect(screen.getByRole('radio', { name: /Solo la cuenta/ })).toHaveAttribute('aria-checked', 'true')
    expect(fake.requests.filter(r => r.pathname.endsWith('/deletion-preview'))).toHaveLength(2)
    await user.click(songOption())
    await user.click(screen.getByRole('button', { name: 'Eliminar cuenta y 38 canciones' }))
    await waitFor(() => expect(screen.queryByText('Member', { exact: true, selector: 'b' })).not.toBeInTheDocument())
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
    expect(await waitFor(() => screen.getByText('Cuenta de Member eliminada · 38 canciones eliminadas · 1,2 GB liberados'))).toBeInTheDocument()
    expect(fake.requests.find(r => r.method === 'DELETE')?.search).toBe('?songs=true')
  })

  it('«Mi cuenta»: the password changes in place and says so', async () => {
    renderPage({ section: 'cuenta', respond: (r) => (r.pathname === '/api/me/password' ? { status: 200, json: { otherDevicesSignedOut: false, deviceCount: 2 } } : undefined) })
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Cambiar la contraseña' })))
    await user.type(screen.getByLabelText('Contraseña actual'), 'old')
    await user.type(screen.getByLabelText('Nueva'), 'new-pass')
    await user.type(screen.getByLabelText('Repite la contraseña'), 'new-pass')
    await user.click(screen.getByRole('button', { name: 'Guardar' }))
    expect(await waitFor(() => screen.getByText('Contraseña cambiada. Tus otros dispositivos siguen con la sesión iniciada.'))).toBeInTheDocument()
    expect(fake?.requests.find((r) => r.pathname === '/api/me/password')?.body).toEqual({ currentPassword: 'old', newPassword: 'new-pass' })
  })
})

describe('settings state audit', () => {
  it('Mi cuenta terminates an HTTP failure and retries the account request', async () => {
    let fail = true
    renderPage({ section: 'cuenta', respond: r => r.pathname === '/api/me' && fail ? { status: 500, json: { detail: 'boom' } } : undefined })
    expect(await waitFor(() => screen.getByText('No se pudo cargar tu cuenta.'))).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Cargando tu cuenta' })).not.toBeInTheDocument()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(await waitFor(() => screen.getByText('Owner'))).toBeInTheDocument()
  })
})

describe('nested source card states', () => {
  it('Mi cuenta resolves a network failure without an HTTP status', async () => {
    renderPage({ section: 'cuenta', respond: r => {
      if (r.pathname === '/api/server/remote-route') return { status: 200, json: r.body }
      if (r.pathname === '/api/me') throw new TypeError('offline')
      return undefined
    } })
    expect(await waitFor(() => screen.getByText('No se pudo cargar tu cuenta.'))).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Cargando tu cuenta' })).not.toBeInTheDocument()
  })
})

describe('personal devices', () => {
  const current = { id: 'd1', label: 'Mac de Owner', isCurrent: true, helper: false }
  const phone = { id: 'd2', label: 'iPhone de Owner', isCurrent: false, helper: false }
  const helper = { id: 'helper', label: 'Helper box', isCurrent: false, helper: true }

  it.each([true, false])('ignores helpers in rows, counts and the single-device hint (flag %s)', async flag => {
    renderPage({ section: 'dispositivos', respond: r => r.pathname === '/api/me/devices' ? { status: 200, json: { devices: [current, flag ? helper : { id: 'old', label: 'Helper box · trabajador', isCurrent: false }] } } : undefined })
    const row = (await waitFor(() => screen.getByText('Mac de Owner'))).closest<HTMLElement>('.ks-group')!
    expect(within(row).queryByText(/Helper box/)).not.toBeInTheDocument()
    expect(within(row).getByText('1', { selector: '.settings-count' })).toBeVisible()
    expect(within(row).getByTitle('Tu sesión solo está iniciada en este equipo.')).toBeVisible()
    expect(within(row).queryByRole('button', { name: 'Quitar' })).not.toBeInTheDocument()
  })

  it('also hides helpers in an expanded account', async () => {
    renderPage({ section: 'cuentas', respond: r => r.pathname === '/api/users/u2/devices' ? { status: 200, json: { devices: [phone, helper] } } : undefined })
    await user.click(await waitFor(() => screen.getByText('Member', { selector: 'b' })))
    const row = screen.getByText('Member', { selector: 'b' }).closest('details')!
    expect(await waitFor(() => within(row).getByText(/iPhone de Owner/))).toBeVisible()
    expect(within(row).queryByText(/Helper box/)).not.toBeInTheDocument()
    expect(within(row).queryByRole('button', { name: 'Cambiar el nombre del dispositivo' })).not.toBeInTheDocument()
  })

  it.each([true, false])('renames a device and keeps its current marker (%s)', async here => {
    let device = here ? { ...current } : { ...phone }
    const { fake } = renderPage({ section: 'dispositivos', respond: r => {
      if (r.method === 'PATCH') {
        expect(r.pathname).toBe(`/api/me/devices/${device.id}`)
        expect(r.body).toEqual({ label: 'Equipo de la sala' })
        device = { ...device, label: 'Equipo de la sala' }
        return { status: 200, json: device }
      }
      if (r.pathname === '/api/me/devices') return { status: 200, json: { devices: [device, helper] } }
      return undefined
    } })
    const row = (await waitFor(() => screen.getByText(device.label))).closest<HTMLElement>('.settings-dev')!
    await user.click(within(row).getByRole('button', { name: 'Cambiar el nombre' }))
    const input = within(row).getByRole('textbox', { name: 'Nombre del dispositivo' })
    expect(input).toHaveFocus()
    expect(within(row).getByRole('button', { name: 'Guardar' })).toBeDisabled()
    await user.clear(input)
    await user.type(input, '  Equipo de la sala  ')
    await user.click(within(row).getByRole('button', { name: 'Guardar' }))
    expect(await waitFor(() => within(row).getByText('Equipo de la sala'))).toBeVisible()
    expect(within(row).queryByText('este equipo') !== null).toBe(here)
    expect(fake.requests.filter(r => r.method === 'PATCH')).toHaveLength(1)
    expect(fake.invocations.filter(r => r.channel === 'auth:clear')).toHaveLength(0)
  })

  it.each([422, 500, 404])('keeps a refused name inline and can cancel (%s)', async status => {
    const { fake } = renderPage({ section: 'dispositivos', respond: r => r.method === 'PATCH' ? { status, json: { detail: status === 404 ? 'Not Found' : 'refused' } } : undefined })
    const row = (await waitFor(() => screen.getByText('MacBook de Owner'))).closest<HTMLElement>('.settings-dev')!
    await user.click(within(row).getByRole('button', { name: 'Cambiar el nombre' }))
    const input = within(row).getByRole('textbox')
    await user.clear(input)
    expect(within(row).getByRole('button', { name: 'Guardar' })).toBeDisabled()
    await user.type(input, 'Otra Mac')
    await user.click(within(row).getByRole('button', { name: 'Guardar' }))
    expect(await waitFor(() => within(row).getByRole('alert'))).toHaveTextContent(status === 422 ? 'Ese nombre no es válido' : status === 404 ? 'Actualiza el nido para usar esta función.' : 'No se pudo cambiar el nombre')
    expect(input).toHaveValue('Otra Mac')
    await user.click(within(row).getByRole('button', { name: 'Cancelar' }))
    expect(within(row).getByText('MacBook de Owner')).toBeVisible()
    expect(within(row).queryByRole('alert')).not.toBeInTheDocument()
    expect(fake.requests.filter(r => r.method === 'PATCH')).toHaveLength(1)
  })
})
