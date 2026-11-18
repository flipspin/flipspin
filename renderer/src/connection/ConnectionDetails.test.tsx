import { useRef, useState } from 'react'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectionStatusList } from './StatusList'
import { ConnectionDetails } from './ConnectionDetails'
import { FirstLaunchScreen } from './FirstLaunchScreen'
import { canvasConnection } from './fixtures'
import { Popover } from '../ui/react/components/Popover'
import { installFakeSettings, type FakeSettings } from '../settings/test-support'
import { DataProvider } from '../data'
import { useNestStatus } from '../shell/ServerBadge'

let fake: FakeSettings
afterEach(() => { fake?.restore(); vi.useRealTimers() })

/** The same shared Popover part B will mount from its banner. */
function DetailsStory() {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  return <><button ref={anchor} onClick={() => setOpen(true)}>Detalles</button>
    <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchor} aria-label="Detalles">
      <ConnectionDetails connection={canvasConnection('caido')} nestName="Nido de casa" mode="external" />
    </Popover>
  </>
}

describe('canvas status rows', () => {
  it.each([
    ['primera', ['Conectada', 'Conectando…', 'Sin verificar']],
    ['tardando', ['Conectada', 'Sin respuesta', 'Sin verificar']],
    ['caido', ['Conectada', 'En línea', 'Detenido']],
    ['fuera', ['Conectada', 'Sin respuesta', 'Sin verificar']],
    ['conectado', ['Conectada', 'En línea', 'Activo']],
  ] as const)('%s: label, word and detail without extra tab stops', (state, words) => {
    const { container } = render(<ConnectionStatusList connection={canvasConnection(state)} away={state === 'fuera'} />)
    expect([...container.querySelectorAll('dt')].map(e => e.textContent)).toEqual(['Red', 'Equipo del nido', 'Flipspin'])
    words.forEach(word => expect(screen.getByText(word, { exact: true })).toBeInTheDocument())
    expect(screen.getByText('puerto 8000')).toBeInTheDocument()
    const states = container.querySelectorAll('.ks-status__state')
    states.forEach(el => {
      expect(el.getAttribute('title')).toBeTruthy()
      expect(el.querySelector('.k-sr-only')).toHaveTextContent(el.getAttribute('title'))
    })
    expect(container.querySelector('[tabindex],button,a')).toBeNull()
    expect(container.textContent).not.toContain('—')
  })

  it('uses the canvas reasons for the slow launch, stopped server and away state', () => {
    const { rerender } = render(<ConnectionStatusList connection={canvasConnection('tardando')} />)
    expect(screen.getByText('Sin respuesta').closest('dd')).toHaveAttribute('title', 'Al abrir Flipspin o al salir del reposo, el sistema puede tardar en darle acceso a la red local. Flipspin lo vuelve a intentar solo.')
    rerender(<ConnectionStatusList connection={canvasConnection('caido')} />)
    expect(screen.getByText('Detenido').closest('dd')).toHaveAttribute('title', 'El equipo responde, pero Flipspin no está activo en él. Puede estar reiniciándose.')
    rerender(<ConnectionStatusList connection={canvasConnection('fuera')} away />)
    expect(screen.getByText('Sin respuesta').closest('dd')).toHaveAttribute('title', 'Fuera de casa, el nido se alcanza con Tailscale, la VPN de tu router o un dominio.')
  })

  it('keeps a bad network and an unrecognized service truthful; fills null host/port details', () => {
    const connection = canvasConnection('caido')
    connection.lastError = 'not-krobi'
    connection.checks[0] = { id: 'this-computer', status: 'bad', detail: null }
    connection.checks[1].detail = null
    connection.checks[2].detail = null
    render(<ConnectionStatusList connection={connection} address="http://192.168.1.20:8000" />)
    expect(screen.getByText('Sin red')).toBeInTheDocument()
    expect(screen.getByText('Sin respuesta')).toBeInTheDocument()
    expect(screen.queryByText('Detenido')).not.toBeInTheDocument()
    expect(screen.getByText('192.168.1.20')).toBeInTheDocument()
    expect(screen.getByText('puerto 8000')).toBeInTheDocument()
  })
})

it('renders Details in the shared Popover and retries through the fake bridge', async () => {
  fake = installFakeSettings()
  render(<DetailsStory />)
  await userEvent.click(screen.getByRole('button', { name: 'Detalles' }))
  const panel = await screen.findByRole('dialog', { name: 'Detalles' })
  expect(within(panel).getByRole('heading', { name: 'Conexión con Nido de casa' })).toBeInTheDocument()
  await userEvent.click(within(panel).getByRole('button', { name: 'Reintentar' }))
  expect(fake.invokedWith('server:retry-now')).toEqual([undefined])
  await userEvent.click(within(panel).getByRole('button', { name: 'Cambiar de nido' }))
  const wizard = await screen.findByRole('dialog', { name: 'Cambiar de nido' })
  expect(within(wizard).getByRole('heading', { name: 'Elige tu nido' })).toBeInTheDocument()
  expect(within(wizard).getByLabelText('Enlace de configuración')).toBeInTheDocument()
})

it('shows remote access only for the remote bad-route fallback and opens that settings section', async () => {
  const remote = vi.fn()
  window.addEventListener('krobi-show-settings', remote)
  try {
    const { rerender } = render(<ConnectionDetails connection={canvasConnection('caido')} mode="external" />)
    expect(screen.queryByRole('button', { name: 'Acceso remoto' })).not.toBeInTheDocument()
    rerender(<ConnectionDetails connection={canvasConnection('fuera')} mode="child" />)
    expect(screen.queryByRole('button', { name: 'Acceso remoto' })).not.toBeInTheDocument()
    rerender(<ConnectionDetails connection={canvasConnection('fuera')} mode="external" away={false} />)
    expect(screen.queryByRole('button', { name: 'Acceso remoto' })).not.toBeInTheDocument()
    rerender(<ConnectionDetails connection={canvasConnection('fuera')} mode="external" />)
    await userEvent.click(screen.getByRole('button', { name: 'Acceso remoto' }))
    expect(remote.mock.calls[0][0].detail).toEqual({ section: 'remoto' })
  } finally { window.removeEventListener('krobi-show-settings', remote) }
})

it('updates the age from connection.since and cleans up its clock', () => {
  vi.useFakeTimers()
  const { rerender, unmount } = render(<ConnectionDetails connection={canvasConnection('caido', Date.now() - 2000)} mode="external" />)
  expect(screen.getByText('revisado hace 2 s')).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(3000))
  expect(screen.getByText('revisado hace 5 s')).toBeInTheDocument()
  rerender(<ConnectionDetails connection={canvasConnection('caido', Date.now())} mode="external" />)
  expect(screen.getByText('revisado hace 0 s')).toBeInTheDocument()
  unmount()
  expect(vi.getTimerCount()).toBe(0)
})

it('uses the supplied nest name and preserves the startup clock across wait remounts', () => {
  vi.useFakeTimers()
  const startedAt = Date.now()
  const props = { connection: canvasConnection('primera'), nestName: 'Nido de casa', startedAt, onChangeNest: vi.fn(), onUseOffline: vi.fn() }
  const first = render(<FirstLaunchScreen {...props} />)
  expect(screen.getByRole('heading', { name: 'Conectando con Nido de casa…' })).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(8000))
  first.unmount()
  render(<FirstLaunchScreen {...props} />)
  act(() => vi.advanceTimersByTime(2000))
  expect(screen.getByText('Está tardando más de lo normal.')).toBeInTheDocument()
})

it('account line follows the shell and uses the shell nest name when connected', async () => {
  const { serverStatus } = await import('../settings/test-support')
  fake = installFakeSettings({ status: serverStatus({ connection: canvasConnection('primera') }), probe: address => ({ ok: true, url: address, handshake: { app: 'krobi', version: '1', instanceId: 'nest', name: 'Nido de casa', isInit: true, authMethods: [] } }) })
  function AccountLine() { const nest = useNestStatus(); return <p>{nest.label}</p> }
  render(<DataProvider><AccountLine /></DataProvider>)
  expect(await screen.findByText('Conectando…')).toBeInTheDocument()
  act(() => fake.emitServerStatus(serverStatus({ connection: canvasConnection('fuera') })))
  expect(screen.getByText('Sin conexión')).toBeInTheDocument()
  act(() => fake.emitServerStatus(serverStatus({ name: 'Nido de casa', connection: canvasConnection('conectado') })))
  expect(await screen.findByText('Nido de casa')).toBeInTheDocument()
})
