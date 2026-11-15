// @vitest-environment jsdom
/** Remote-access tests verify nest addresses through the real `server:probe` channel. */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { IpcInvokeContract } from '../lib/ipc'

import { DataProvider } from '../data'
import { installFakeSettings } from '../settings/test-support'
import type { FakeSettings, ResponseSpec, RecordedRequest } from '../settings/test-support'
import { RemoteStep } from './RemoteStep'

const ORIGIN = 'http://192.168.1.20:8000'
const NETWORK = {
  lan: [ORIGIN],
  tailscale: { ip: '100.101.1.2', name: 'krobi.tail4c2e.ts.net', url: 'http://100.101.1.2:8000' },
  externalUrl: null,
}

type Probe = IpcInvokeContract['server:probe']['response']
const answers = (instanceId: string): Probe => ({
  ok: true,
  url: '',
  handshake: { app: 'krobi', version: '1', instanceId, isInit: true, authMethods: ['token'] },
})

let fake: FakeSettings | null = null

afterEach(() => {
  fake?.restore()
  fake = null
})

function start(
  options: {
    network?: typeof NETWORK
    probe?: Record<string, Probe>
    respond?: (r: RecordedRequest) => ResponseSpec | undefined
  } = {},
) {
  fake = installFakeSettings({
    origin: ORIGIN,
    probe: (address) => (address === ORIGIN ? answers('nest-1') : (options.probe?.[address] ?? { ok: false, reason: 'unreachable' })),
    respond: (request) => {
      const own = options.respond?.(request)
      if (own) return own
      if (request.pathname === '/api/server/remote-route') return { status: 200, json: request.body }
      if (request.pathname === '/api/server/network') return { status: 200, json: options.network ?? NETWORK }
      return undefined
    },
  })
  const onDone = vi.fn()
  render(
    <DataProvider>
      <RemoteStep nestName="Nido de krobi" host={null} onBack={() => {}} onDone={onDone} />
    </DataProvider>,
  )
  return { fake, onDone }
}

describe('remote access', () => {
  it('offers only Tailscale or "Later", with nothing preselected and no domain or WireGuard', async () => {
    start()
    expect(await screen.findByRole('radio', { name: /Usar Tailscale/ })).not.toBeChecked()
    expect(screen.getByRole('radio', { name: /Más tarde/ })).not.toBeChecked()
    expect(screen.getAllByRole('radio')).toHaveLength(2)
    expect(screen.queryByLabelText('Dominio')).toBeNull()
    expect(screen.queryByText('WireGuard')).toBeNull()
    expect(document.querySelector('.kob-option.is-picked .kob-dot.is-ok')).toBeNull()
  })

  it('shows install commands when Tailscale is missing, with detection refresh', async () => {
    start({ network: { ...NETWORK, tailscale: null } })
    await userEvent.click(await screen.findByRole('radio', { name: /Usar Tailscale/ }))
    expect(await screen.findByText('No detectado')).toBeInTheDocument()
    expect(document.querySelector('.kob-option.is-picked .kob-dot.is-ok')).toBeNull()
    expect(screen.getByText('sudo tailscale up')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(fake!.requests.filter(r => r.pathname === '/api/server/network').length).toBeGreaterThan(1)
  })

  it('records only a Tailscale address that answers as this nest', async () => {
    const { onDone } = start({ probe: { 'http://100.101.1.2:8000': answers('nest-1') } })
    await userEvent.click(await screen.findByRole('radio', { name: /Usar Tailscale/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Revisar' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: /Usar Tailscale/ }).closest('.kob-option')).toHaveTextContent('Conectado'))
    const card = screen.getByRole('radio', { name: /Usar Tailscale/ })
    expect(card).toBeChecked()
    expect(card.closest('.kob-option')?.querySelector('.kob-dot')).toHaveClass('is-ok')
    expect(screen.queryByText('Dirección local')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    expect(onDone).toHaveBeenCalledWith('tailscale')
    expect(fake!.requests.find(r => r.pathname === '/api/server/remote-route')?.body).toEqual({ route: 'tailscale' })
  })

  it.each(['unchecked', 'other-nest', 'unreachable'])('records local only for %s Tailscale', async kind => {
    const { onDone } = start({ probe: kind === 'other-nest' ? { 'http://100.101.1.2:8000': answers('nest-2') } : {} })
    await userEvent.click(await screen.findByRole('radio', { name: /Usar Tailscale/ }))
    if (kind !== 'unchecked') {
      await userEvent.click(screen.getByRole('button', { name: 'Revisar' }))
      await waitFor(() => expect(screen.getByRole('radio', { name: /Usar Tailscale/ }).closest('.kob-option')).toHaveTextContent(kind === 'other-nest' ? 'Responde otro nido' : 'Sin respuesta'))
    }
    const card = screen.getByRole('radio', { name: /Usar Tailscale/ })
    expect(card).toBeChecked()
    expect(card.closest('.kob-option')?.querySelector('.kob-dot')).toHaveClass('is-off')
    await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
    expect(onDone).toHaveBeenCalledWith('local')
    expect(fake!.requests.find(r => r.pathname === '/api/server/remote-route')?.body).toEqual({ route: 'local' })
  })

  it.each(['Siguiente', 'Omitir'])('keeps an unselected route local for navigation action %#', async label => {
    const { onDone } = start()
    await screen.findByRole('radio', { name: /Más tarde/ })
    await userEvent.click(screen.getByRole('button', { name: label }))
    expect(onDone).toHaveBeenCalledWith('local')
    expect(fake!.requests.find(r => r.pathname === '/api/server/remote-route')?.body).toEqual({ route: 'local' })
  })
})

it('does not finish the wizard when storing the route fails', async () => {
  const { onDone } = start({ respond: r => r.pathname === '/api/server/remote-route' ? { status: 500, json: { detail: 'boom' } } : undefined })
  await screen.findByRole('radio', { name: /Más tarde/ })
  await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo guardar el acceso remoto.')
  expect(onDone).not.toHaveBeenCalled()
})
