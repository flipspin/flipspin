import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { installFakeSettings, serverStatus, type FakeSettings } from '../settings/test-support'
import { NestStep, INSTALL_COMMAND } from './NestStep'
import { SERVER_IMAGE } from '../brand'
import { forgetSetupCode, setupCodeFor } from '../setup/setupLink'

let fake: FakeSettings | undefined
afterEach(() => { fake?.restore(); fake = undefined })

const discovered = { url: 'http://192.0.2.10:8000', name: 'Nido', instanceId: 'nest-1', version: '0.1.0' }

describe('the nest list', () => {
  it('makes the nest on this computer with server:use(null), without a welcome back button', async () => {
    fake = installFakeSettings({ deviceName: 'MacBook Pro' })
    render(<NestStep mode="unchosen" />)
    const button = screen.getByRole('button', { name: 'Crear nido aquí' })
    expect(button).toHaveAttribute('title', 'Flipspin guarda tu música y tu cuenta en este equipo. Tus otros dispositivos se conectan a él.')
    expect(screen.queryByRole('button', { name: 'Atrás' })).toBeNull()
    expect(await screen.findByText('MacBook Pro', { selector: '.kob-nest-name > span' })).toBeInTheDocument()
    expect(screen.getByText('Sin nido').querySelector('.kob-dot')).toHaveClass('is-off')
    await userEvent.click(button)
    expect(fake.invocations.find(call => call.channel === 'server:use')?.request).toEqual({ address: null })
  })

  it('discovers immediately, deduplicates nests, and connects directly to the confirmed address', async () => {
    fake = installFakeSettings({ nests: [discovered, { ...discovered, url: 'http://192.0.2.11:8000' }, { ...discovered, instanceId: null, url: 'http://old.test:8000' }] })
    render(<NestStep mode="unchosen" />)
    const list = document.querySelector('.kob-rows') as HTMLElement
    const buttons = await within(list).findAllByRole('button', { name: 'Conectar' })
    expect(buttons).toHaveLength(2)
    expect(screen.getByText('192.0.2.10:8000 · v0.1.0')).toHaveClass('kob-mono')
    await userEvent.click(buttons[0])
    expect(fake.invocations.find(call => call.channel === 'server:use')?.request).toEqual({ address: discovered.url })
    expect(fake.invocations.some(call => call.channel === 'server:probe')).toBe(false)
  })

  it('tests another address and adds the answering, unclaimed nest as a Connect row', async () => {
    fake = installFakeSettings({ probe: () => ({ ok: true, url: 'http://server.test:8000', handshake: { app: 'krobi', version: '0.1.0', instanceId: 'new-nest', isInit: false, authMethods: ['token'] } }) })
    render(<NestStep mode="unchosen" join />)
    expect(screen.getByLabelText('Enlace de configuración')).toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: 'Escribir una dirección' }))
    const list = document.querySelector('.kob-rows') as HTMLElement
    expect(within(list).queryByRole('button', { name: 'Conectar' })).toBeNull()
    await userEvent.type(screen.getByLabelText('Dirección'), 'server.test:8000')
    await userEvent.click(screen.getByRole('button', { name: 'Probar' }))
    const connect = await within(list).findByRole('button', { name: 'Conectar' })
    expect(within(connect.closest('.kob-row') as HTMLElement).getByText('Nido')).toBeInTheDocument()
    expect(screen.getByText('server.test:8000 · v0.1.0')).toBeInTheDocument()
    expect(fake.invocations.some(call => call.channel === 'server:use')).toBe(false)
    await userEvent.click(connect)
    expect(fake.invocations.find(call => call.channel === 'server:use')?.request).toEqual({ address: 'http://server.test:8000' })
  })

  it('toggles the install command and keeps direct Docker details behind Other methods', async () => {
    fake = installFakeSettings({})
    render(<NestStep mode="unchosen" />)
    const toggle = screen.getByRole('button', { name: 'Instalar en un servidor' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText(INSTALL_COMMAND)).toBeNull()
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(INSTALL_COMMAND)).toBeInTheDocument()
    const details = screen.getByText('Otros métodos').closest('details')!
    expect(details).not.toHaveAttribute('open')
    await userEvent.click(screen.getByText('Otros métodos'))
    expect(details).toHaveAttribute('open')
    expect(details.textContent).toContain(SERVER_IMAGE)
    expect(screen.getByText('Al terminar imprime un enlace de configuración. Pégalo arriba.')).toBeInTheDocument()
    await userEvent.click(toggle)
    expect(screen.queryByText(INSTALL_COMMAND)).toBeNull()
  })

  it('keeps probe failure words and never creates a Connect row for a failed probe', async () => {
    fake = installFakeSettings({ probe: () => ({ ok: false, reason: 'unreachable' }) })
    render(<NestStep mode="unchosen" />)
    await userEvent.click(screen.getByRole('button', { name: 'Escribir una dirección' }))
    await userEvent.type(screen.getByLabelText('Dirección'), 'offline.test')
    await userEvent.click(screen.getByRole('button', { name: 'Probar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Nada respondió/)
    expect(within(document.querySelector('.kob-rows') as HTMLElement).queryByRole('button', { name: 'Conectar' })).toBeNull()
  })

  it('shows a locked choice failure and leaves the choices usable', async () => {
    fake = installFakeSettings({ status: serverStatus({ mode: 'external' }), use: () => ({ ok: false, reason: 'locked' }) })
    render(<NestStep mode="external" />)
    await userEvent.click(screen.getByRole('button', { name: 'Crear nido aquí' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo usar ese nido.')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Crear nido aquí' })).toBeEnabled())
  })

  it('connects from a pasted setup link, keeping its code only for the account step and out of every log', async () => {
    fake = installFakeSettings({})
    render(<NestStep mode="unchosen" />)
    const code = 'Xq3vK9_bT2mLp8Rw4ZcN7yHd1JfU6sAeG0oVtYiWnQk'
    await userEvent.type(screen.getByLabelText('Enlace de configuración'), `krobi://192.168.1.20:8000/setup#${code}`)
    await userEvent.click(within(screen.getByLabelText('Enlace de configuración').closest('form') as HTMLElement).getByRole('button', { name: 'Conectar' }))
    await waitFor(() => expect(fake!.invocations.find(call => call.channel === 'server:use')?.request).toEqual({ address: 'http://192.168.1.20:8000' }))
    expect(setupCodeFor('http://192.168.1.20:8000')).toBe(code)
    expect(JSON.stringify(fake.invocations)).not.toContain(code)
    forgetSetupCode()
  })

  it('refuses a link without a valid code and says why', async () => {
    fake = installFakeSettings({})
    render(<NestStep mode="unchosen" />)
    await userEvent.type(screen.getByLabelText('Enlace de configuración'), 'krobi://192.168.1.20:8000/setup#short')
    await userEvent.click(within(screen.getByLabelText('Enlace de configuración').closest('form') as HTMLElement).getByRole('button', { name: 'Conectar' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('El código de este enlace no es válido. Cópialo completo.')
    expect(fake.invocations.some(call => call.channel === 'server:use')).toBe(false)
  })
})


it('saves proxy headers before probing a protected nest without putting them in the setup link', async () => {
  fake = installFakeSettings({ probe: () => ({ ok: false, reason: 'unreachable' }) })
  render(<NestStep mode="unchosen" />)
  await userEvent.click(screen.getByRole('button', { name: 'Escribir una dirección' }))
  fireEvent.change(screen.getByLabelText('Dirección'), { target: { value: 'https://protected.example/krobi' } })
  const summary = screen.getByText('Cabeceras personalizadas', { selector: 'summary' })
  await userEvent.click(summary)
  const add = screen.getByRole('button', { name: 'Añadir cabecera' })
  await waitFor(() => expect(add).toBeEnabled())
  await userEvent.click(add)
  fireEvent.change(screen.getByLabelText('Nombre de cabecera'), { target: { value: 'X-Proxy-Secret' } })
  fireEvent.change(screen.getByLabelText('Valor de cabecera'), { target: { value: 'fixture-proxy-secret' } })
  await userEvent.click(screen.getByRole('button', { name: 'Guardar cabeceras' }))
  await screen.findByLabelText('Valor de cabecera guardado')
  expect(fake.invocations.find(call => call.channel === 'headers:set')?.request).toEqual({ origin: 'https://protected.example/krobi', headers: [{ name: 'X-Proxy-Secret', value: 'fixture-proxy-secret' }] })
  await userEvent.click(screen.getByRole('button', { name: 'Probar' }))
  expect(fake.invocations.find(call => call.channel === 'server:probe')?.request).toEqual({ address: 'https://protected.example/krobi' })
})
