import { MIN_PASSWORD } from '../auth/CreateAccount'
import { waitForUi as waitFor } from '../test/test-clock'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { chromium } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import codeContract from '../../../contracts/sign-in-code.json'
import themeCss from '../styles/theme.css?raw'
import primitivesCss from '../ui/primitives.css?raw'
import baseCss from '../ui/tokens/base.css?raw'
import personalCss from '../ui/tokens/personal.css?raw'
import { ME_ADMIN, ME_NORMAL, renderPage } from './page-test-support'
import settingsCss from './settings.css?raw'

describe('Mis dispositivos → apps Subsonic', () => {
  it.each([ME_ADMIN, ME_NORMAL])('lets $role mint a one-shot API key from the current pairing kit', async me => {
    const key = 'one-shot-subsonic-key'
    const { fake } = renderPage({ section: 'dispositivos', me, respond: r => r.pathname === '/api/me/devices/api-key'
      ? { status: 201, json: { device: { id: 'd3', label: 'Crossonic', createdAt: null, lastSeenAt: null }, token: key } }
      : undefined })
    await userEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Agregar una app de música' })))
    const dialog = within(screen.getByRole('dialog', { name: 'Agregar una app de música' }))
    expect(dialog.getAllByRole('radio')).toHaveLength(9)
    await userEvent.click(dialog.getByRole('radio', { name: 'Crossonic' }))
    await userEvent.click(dialog.getByRole('button', { name: 'Crear' }))
    expect(await waitFor(() => dialog.getByText(key))).toBeVisible()
    expect(dialog.queryByText(me.username)).not.toBeInTheDocument()
    await userEvent.click(dialog.getByRole('button', { name: 'Listo' }))
    expect(screen.queryByText(key)).not.toBeInTheDocument()
    await userEvent.click(dialog.getByRole('button', { name: /^Cerrar$/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Agregar una app de música' }))
    expect(screen.queryByText(key)).not.toBeInTheDocument()
    expect(fake.requests.filter(r => r.method === 'POST').map(r => r.pathname)).toEqual(['/api/me/devices/api-key'])
  })

  it('keeps the two cards and long API key inside the current modal on desktop and phone', async () => {
    const key = 'A'.repeat(43)
    const { baseElement } = renderPage({ section: 'dispositivos', respond: r => r.pathname === '/api/me/devices/api-key'
      ? { status: 201, json: { device: { id: 'd3', label: 'Crossonic' }, token: key } }
      : undefined })
    await userEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Agregar una app de música' })))
    const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote', '--in-process-gpu'] })
    try {
      const page = await browser.newPage()
      const measure = async (width: number, reveal: boolean) => {
        await page.setViewportSize({ width, height: 900 })
        await page.setContent(`<style>${themeCss}\n${baseCss}\n${personalCss}\n${primitivesCss}\n${settingsCss}</style>${baseElement.querySelector('.settings')!.outerHTML}`)
        const bounds = await page.getByRole('dialog').evaluate(el => ({
          left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right,
          overflow: el.scrollWidth > el.clientWidth,
        }))
        expect(bounds.left).toBeGreaterThanOrEqual(0)
        expect(bounds.right).toBeLessThanOrEqual(width)
        expect(bounds.overflow).toBe(false)
        if (!reveal) {
          const cards = await page.getByRole('radio').all()
          const first = (await cards[0].boundingBox())!
          const second = (await cards[1].boundingBox())!
          expect(first.y).toBe(second.y)
        }
      }
      await measure(1100, false)
      await measure(390, false)
      await userEvent.type(screen.getByRole('textbox', { name: 'Nombre de la app' }), 'Crossonic')
      await userEvent.click(screen.getByRole('button', { name: 'Crear' }))
      await waitFor(() => screen.getByText(key))
      await measure(390, true)
      await measure(1100, true)
    } finally { await browser.close() }
  }, 20_000)
})

describe('account recovery and code approval', () => {
  it('a normal account opens the facts sheet before approving a typed code', async () => {
    const { fake } = renderPage({ me: ME_NORMAL, section: 'dispositivos', respond: r => {
      if (r.pathname === '/api/me/sign-in-code/ABC234') return { status: 200, json: {
        id: 'request-1', code: 'ABC234', deviceLabel: 'Safari en Mac', network: 'local',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString(),
      } }
      if (r.pathname === '/api/me/sign-in-code') return { status: 200, json: { success: true } }
      return undefined
    } })
    const button = await waitFor(() => screen.getByRole('button', { name: 'Aprobar código' }))
    const header = screen.getByRole('heading', { name: 'Dispositivos' }).parentElement!
    expect(within(header).getAllByRole('button').map(button => button.textContent)).toEqual(['Aprobar código', 'Vincular dispositivo'])
    expect(screen.queryByRole('heading', { name: 'Aprobar un código' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await userEvent.click(button)
    const dialog = screen.getByRole('dialog', { name: 'Código del otro dispositivo' })
    const boxes = within(dialog).getAllByRole('textbox')
    expect(within(dialog).getByRole('group', { name: 'Código del otro dispositivo' })).toBeInTheDocument()
    expect(boxes).toHaveLength(6)
    boxes.forEach((box, index) => expect(box).toHaveAccessibleName(`carácter ${index + 1} de 6`))
    expect(boxes[0]).toHaveFocus()
    expect(within(dialog).getAllByRole('button')).toHaveLength(1)
    await userEvent.keyboard('abc23')
    expect(boxes.map(box => (box as HTMLInputElement).value)).toEqual(['A', 'B', 'C', '2', '3', ''])
    expect(boxes[5]).toHaveFocus()
    expect(fake.requests.some(r => r.pathname.includes('/api/me/sign-in-code/'))).toBe(false)
    await userEvent.keyboard('4')
    const sheet = await waitFor(() => screen.getByRole('dialog', { name: 'quiere entrar' }))
    expect(dialog).not.toBeInTheDocument()
    expect(fake.requests.filter(r => r.pathname === '/api/me/sign-in-code/ABC234')).toHaveLength(1)
    expect(within(sheet).getByText('Safari en Mac')).toBeInTheDocument()
    expect(within(sheet).getByText('member')).toBeInTheDocument()
    expect(fake.requests.some(r => r.pathname === '/api/me/sign-in-code')).toBe(false)
    await userEvent.click(within(sheet).getByRole('button', { name: 'Aprobar' }))
    expect(await waitFor(() => within(sheet).getByRole('status'))).toHaveTextContent('Safari en Mac conectado')
    expect(fake.requests.find(r => r.pathname === '/api/me/sign-in-code')?.body).toEqual({ code: 'ABC234' })
  })

  it.each([404, 410])('clears an unavailable code (%s), shakes once, and accepts a retry', async status => {
    const { fake } = renderPage({ section: 'dispositivos', respond: r => r.pathname === '/api/me/sign-in-code/ABC234'
      ? { status, json: { detail: 'gone' } } : undefined })
    await userEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Aprobar código' })))
    const group = screen.getByRole('group', { name: 'Código del otro dispositivo' })
    const boxes = within(group).getAllByRole('textbox')
    await userEvent.keyboard('ABC234')
    expect(await waitFor(() => screen.getByRole('alert'))).toHaveTextContent('Código no válido')
    boxes.forEach(box => expect(box).toHaveValue(''))
    expect(boxes[0]).toHaveFocus()
    expect(group).toHaveClass('is-shaking')
    await userEvent.keyboard('a')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(boxes[0]).toHaveValue('A')
    expect(boxes[1]).toHaveFocus()
    await userEvent.keyboard('BC234')
    expect(await waitFor(() => screen.getByRole('alert'))).toHaveTextContent('Código no válido')
    expect(group).toHaveClass('is-shaking')
    expect(fake.requests.filter(r => r.pathname === '/api/me/sign-in-code/ABC234')).toHaveLength(2)
  })

  it.each(codeContract.format)('handles pasted contract input $input', async ({ input, valid, normalized }) => {
    const { fake } = renderPage({ section: 'dispositivos', respond: r => r.pathname === `/api/me/sign-in-code/${normalized}`
      ? { status: 200, json: { id: 'pasted', code: normalized, deviceLabel: 'Safari en Mac', network: 'local',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() } } : undefined })
    const user = userEvent.setup()
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Aprobar código' })))
    await user.keyboard('xyz')
    // A complete paste replaces all boxes even from the middle of the group.
    await user.paste(input)
    if (valid) {
      const sheet = await waitFor(() => screen.getByRole('dialog', { name: 'quiere entrar' }))
      expect(within(sheet).getByText(`${normalized.slice(0, 3)}-${normalized.slice(3)}`)).toBeInTheDocument()
      expect(screen.queryByRole('dialog', { name: 'Código del otro dispositivo' })).not.toBeInTheDocument()
      expect(fake.requests.filter(r => r.pathname === `/api/me/sign-in-code/${normalized}`)).toHaveLength(1)
    } else {
      expect(screen.getAllByRole('textbox').map(box => (box as HTMLInputElement).value)).toEqual(['X', 'Y', 'Z', '', '', ''])
      expect(fake.requests.some(r => r.pathname.includes('/api/me/sign-in-code/'))).toBe(false)
    }
  })

  it('rejects characters outside the alphabet and moves left with Backspace', async () => {
    renderPage({ section: 'dispositivos' })
    await userEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Aprobar código' })))
    const boxes = screen.getAllByRole('textbox')
    await userEvent.keyboard('01io! -')
    expect(boxes[0]).toHaveValue('')
    expect(boxes[0]).toHaveFocus()
    await userEvent.keyboard('ab{Backspace}')
    expect(boxes[0]).toHaveValue('A')
    expect(boxes[1]).toHaveValue('')
    expect(boxes[1]).toHaveFocus()
    await userEvent.keyboard('{Backspace}')
    expect(boxes[0]).toHaveValue('')
    expect(boxes[0]).toHaveFocus()
    await userEvent.keyboard('{Backspace}')
    expect(boxes[0]).toHaveFocus()
  })

  it.each(['Escape', 'close button'])('closes with %s and restores focus without closing Settings', async method => {
    const { onClose } = renderPage({ section: 'dispositivos' })
    const button = await waitFor(() => screen.getByRole('button', { name: 'Aprobar código' }))
    await userEvent.click(button)
    const dialog = screen.getByRole('dialog', { name: 'Código del otro dispositivo' })
    if (method === 'Escape') await userEvent.keyboard('{Escape}')
    else await userEvent.click(within(dialog).getByRole('button', { name: 'Cerrar' }))
    expect(dialog).not.toBeInTheDocument()
    expect(button).toHaveFocus()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('ignores a lookup that finishes after the code dialog closes', async () => {
    renderPage({ section: 'dispositivos' })
    await userEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Aprobar código' })))
    const originalFetch = globalThis.fetch
    let resolve!: (response: Response) => void
    const delayed = new Promise<Response>(done => { resolve = done })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
      new URL((input as Request).url).pathname === '/api/me/sign-in-code/ABC234' ? delayed : originalFetch(input, init))
    try {
      await userEvent.keyboard('ABC234')
      expect(screen.getAllByRole('textbox')[5]).toHaveAttribute('readonly')
      await userEvent.keyboard('{Escape}')
      await act(async () => { resolve(new Response(JSON.stringify({ id: 'late', code: 'ABC234', deviceLabel: 'Safari en Mac', network: 'local',
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() }), { status: 200, headers: { 'content-type': 'application/json' } })) })
      expect(screen.queryByRole('dialog', { name: 'quiere entrar' })).not.toBeInTheDocument()
    } finally { fetch.mockRestore() }
  })

  it('an admin resets another account and cannot reset itself here', async () => {
    const { fake } = renderPage({ section: 'cuentas', respond: r =>
      r.pathname === '/api/users/u2/password' ? { status: 200, json: { success: true, otherDevicesSignedOut: false, deviceCount: 2 } } : undefined })
    await waitFor(() => screen.getByText('Member', { selector: 'b' }))
    expect(screen.queryByRole('button', { name: 'Restablecer contraseña' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByText('Member', { selector: 'b' }))
    await userEvent.click(screen.getByRole('button', { name: 'Restablecer contraseña' }))
    const modal = screen.getByRole('dialog', { name: 'Restablecer contraseña de Member' })
    await userEvent.type(within(modal).getByLabelText('Nueva contraseña'), 'new-temporary-password')
    expect(within(modal).getByRole('button', { name: 'Restablecer contraseña' })).toBeDisabled()
    await userEvent.type(within(modal).getByLabelText('Repite la contraseña'), 'new-temporary-password')
    await userEvent.click(within(modal).getByRole('button', { name: 'Restablecer contraseña' }))
    expect(await waitFor(() => within(modal).getByRole('status'))).toHaveTextContent('Sus dispositivos siguen conectados.')
    expect(fake.requests.find(r => r.pathname === '/api/users/u2/password')?.body).toEqual({ newPassword: 'new-temporary-password' })
    expect(within(modal).queryByLabelText('Nueva contraseña')).not.toBeInTheDocument()
  })

  it('a new account has one name, its username, and needs a password', async () => {
    const { fake } = renderPage({ section: 'cuentas', respond: r =>
      r.pathname === '/api/users' && r.method === 'POST' ? { status: 201, json: { user: { id: 'u9', label: 'ana', role: 'member', createdAt: '2026-11-19T18:00:00Z', lastSeenAt: null }, token: 'tok-ana' } } : undefined })
    await waitFor(() => screen.getByText('Member', { selector: 'b' }))
    await userEvent.click(screen.getByRole('button', { name: /Nueva cuenta/ }))
    const modal = screen.getByRole('dialog', { name: 'Nueva cuenta' })
    const create = within(modal).getByRole('button', { name: 'Crear la cuenta' })
    expect(within(modal).queryByLabelText('Nombre')).toBeNull()
    await userEvent.type(within(modal).getByLabelText('Nombre de usuario'), 'ana')
    await userEvent.type(within(modal).getByLabelText('Contraseña'), 'a-long-enough-password')
    expect(create).toBeDisabled()
    await userEvent.type(within(modal).getByLabelText('Confirmar contraseña'), 'a-long-enough-password')
    await userEvent.click(create)
    await waitFor(() => expect(within(modal).getByText('ana', { selector: 'b' })).toBeInTheDocument())
    expect(fake.requests.find(r => r.pathname === '/api/users' && r.method === 'POST')?.body)
      .toEqual({ label: 'ana', role: 'member', username: 'ana', password: 'a-long-enough-password' })
  })

  it('resetting an account made with only a token shows its username field from the start and sends both together', async () => {
    const { fake } = renderPage({ section: 'cuentas', respond: r => {
      if (r.pathname === '/api/users/u2/sign-in') return { status: 200, json: { username: null, hasPassword: false } }
      if (r.pathname === '/api/users/u2/password') return { status: 200, json: { success: true, otherDevicesSignedOut: false, deviceCount: 1 } }
      return undefined
    } })
    await waitFor(() => screen.getByText('Member', { selector: 'b' }))
    await userEvent.click(screen.getByText('Member', { selector: 'b' }))
    await userEvent.click(screen.getByRole('button', { name: 'Poner contraseña' }))
    const modal = screen.getByRole('dialog', { name: 'Restablecer contraseña de Member' })
    // Asked before anything is typed, and suggested from the account's name.
    const username = await within(modal).findByLabelText(/Nombre de usuario/)
    expect(username).toHaveValue('member')
    expect(within(modal).queryByRole('alert')).toBeNull()
    await userEvent.clear(username)
    await userEvent.type(username, 'member-one')
    await userEvent.type(within(modal).getByLabelText('Nueva contraseña'), 'new-temporary-password')
    await userEvent.type(within(modal).getByLabelText('Repite la contraseña'), 'new-temporary-password')
    await userEvent.click(within(modal).getByRole('button', { name: 'Restablecer contraseña' }))
    expect(await waitFor(() => within(modal).getByRole('status'))).toHaveTextContent('Sus dispositivos siguen conectados.')
    expect(fake.requests.filter(r => r.pathname === '/api/users/u2/password').at(-1)?.body)
      .toEqual({ newPassword: 'new-temporary-password', username: 'member-one' })
    expect(fake.requests.filter(r => r.pathname === '/api/users/u2/password')).toHaveLength(1)
  })

  it.each([
    [{ username: null, hasPassword: false }, ['Sin definir', 'Sin definir'], 'Poner contraseña', false],
    [{ username: 'member', hasPassword: true }, ['member'], 'Restablecer contraseña', true],
  ])('the account panel shows how an account signs in, never a password it has not got (%j)', async (signIn, shown, action, dots) => {
    renderPage({ section: 'cuentas', respond: r => r.pathname === '/api/users/u2/sign-in' ? { status: 200, json: signIn } : undefined })
    await waitFor(() => screen.getByText('Member', { selector: 'b' }))
    await userEvent.click(screen.getByText('Member', { selector: 'b' }))
    expect(await screen.findAllByText(shown[0])).toHaveLength(shown.length)
    expect(screen.queryByText('••••••••') !== null).toBe(dots)
    expect(screen.getByRole('button', { name: action })).toBeInTheDocument()
  })

  it('resetting accepts a password at the shared minimum length', async () => {
    const { fake } = renderPage({ section: 'cuentas', respond: r => {
      if (r.pathname === '/api/users/u2/sign-in') return { status: 200, json: { username: 'member', hasPassword: true } }
      if (r.pathname === '/api/users/u2/password') return { status: 200, json: { success: true, otherDevicesSignedOut: false, deviceCount: 1 } }
      return undefined
    } })
    await waitFor(() => screen.getByText('Member', { selector: 'b' }))
    await userEvent.click(screen.getByText('Member', { selector: 'b' }))
    await userEvent.click(screen.getByRole('button', { name: 'Restablecer contraseña' }))
    const modal = screen.getByRole('dialog', { name: 'Restablecer contraseña de Member' })
    await waitFor(() => expect(fake.requests.some(r => r.pathname === '/api/users/u2/sign-in')).toBe(true))
    const atMinimum = 'x'.repeat(MIN_PASSWORD)
    const submit = within(modal).getByRole('button', { name: 'Restablecer contraseña' })
    await userEvent.type(within(modal).getByLabelText('Nueva contraseña'), atMinimum.slice(1))
    await userEvent.type(within(modal).getByLabelText('Repite la contraseña'), atMinimum.slice(1))
    expect(submit).toBeDisabled()
    await userEvent.type(within(modal).getByLabelText('Nueva contraseña'), 'x')
    await userEvent.type(within(modal).getByLabelText('Repite la contraseña'), 'x')
    expect(submit).toBeEnabled()
  })

  it('resetting an account that already has a username shows no username field', async () => {
    const { fake } = renderPage({ section: 'cuentas', respond: r => {
      if (r.pathname === '/api/users/u2/sign-in') return { status: 200, json: { username: 'member', hasPassword: true } }
      if (r.pathname === '/api/users/u2/password') return { status: 200, json: { success: true, otherDevicesSignedOut: false, deviceCount: 1 } }
      return undefined
    } })
    await waitFor(() => screen.getByText('Member', { selector: 'b' }))
    await userEvent.click(screen.getByText('Member', { selector: 'b' }))
    await userEvent.click(screen.getByRole('button', { name: 'Restablecer contraseña' }))
    const modal = screen.getByRole('dialog', { name: 'Restablecer contraseña de Member' })
    await waitFor(() => expect(fake.requests.some(r => r.pathname === '/api/users/u2/sign-in')).toBe(true))
    await userEvent.type(within(modal).getByLabelText('Nueva contraseña'), 'new-temporary-password')
    await userEvent.type(within(modal).getByLabelText('Repite la contraseña'), 'new-temporary-password')
    expect(within(modal).queryByLabelText(/Nombre de usuario/)).toBeNull()
    await userEvent.click(within(modal).getByRole('button', { name: 'Restablecer contraseña' }))
    expect(await waitFor(() => within(modal).getByRole('status'))).toHaveTextContent('Sus dispositivos siguen conectados.')
    expect(fake.requests.filter(r => r.pathname === '/api/users/u2/password').at(-1)?.body).toEqual({ newPassword: 'new-temporary-password' })
  })
})

it('opens code approval after Home has cached this account’s devices', async () => {
  renderPage({ followup: true, section: 'dispositivos' })
  await userEvent.click(await waitFor(() => screen.getByRole('button', { name: 'Aprobar código' })))
  expect(screen.getByLabelText('carácter 1 de 6')).toBeInTheDocument()
  expect(await waitFor(() => screen.getByText('MacBook de Owner'))).toBeInTheDocument()
  expect(screen.queryByText('Algo se rompió en esta pantalla')).not.toBeInTheDocument()
})
