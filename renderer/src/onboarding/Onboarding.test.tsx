import { clockUser, installTestClock, waitForClock as waitFor } from '../test/test-clock'

import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DataProvider } from '../data'
import { Onboarding } from './Onboarding'
import { SetupEmptyStates } from './SetupEmptyStates'
import { setLanguage } from '../i18n'
import { AuthGate } from '../auth/AuthGate'
import { bridge, setFakeBridgeForTest } from '../bridge'
import { installFakeSettings, serverStatus } from '../settings/test-support'
import type { FakeSettings } from '../settings/test-support'

import { getRoute, _resetRouteForTest } from '../shell/routeStore'
import { useSettingsNavigation } from '../settings/useSettingsNavigation'
import { useState } from 'react'

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


const helper = vi.hoisted(() => ({ set: vi.fn() }))
vi.mock('../lyrics/macEngine', () => ({
  refreshMac: vi.fn(async () => null),
  setMacWorker: helper.set,
  useMacEngine: () => ({ available: true, lastError: null, status: { supported: true, eligible: true, enabled: false, hardware: { memoryBytes: 16 * 2 ** 30, jobs: ['align', 'stems'] } } }),
}))
beforeEach(() => { helper.set.mockReset().mockResolvedValue(undefined) })
let fake: FakeSettings | null = null
let restoreInner: (() => void) | null = null
const pickerHolder = globalThis as unknown as { window: { desktopAPI?: { selectBaseDir?: () => Promise<string | null> } } }

afterEach(() => {
  restoreInner?.()
  restoreInner = null
  fake?.restore()
  fake = null
  delete pickerHolder.window.desktopAPI
  localStorage.clear()
  setLanguage('es')
  history.replaceState(null, '', '/')
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__
  _resetRouteForTest()
})

const SUMMARY = { folder: '/music', songs: 12340, albums: 1102, artists: 418 }

/** The fake shell makes `auth:get` reflect `auth:set` so gate checks see the current identity. */
function freshNest(
  extra: (pathname: string, method: string) => { status: number; json?: unknown } | undefined = () => undefined,
  signedIn = false,
) {
  fake = installFakeSettings({
    status: serverStatus({ mode: 'child' }),
    probe: (address) => ({ ok: true, url: address, handshake: { app: 'krobi', version: '1', instanceId: 'nest-1', isInit: true, authMethods: ['token'] } }),
    identity: { hasToken: false, userId: null, label: null, role: null },
    respond: (request) => {
      const { pathname, method } = request
      const answer = extra(pathname, method)
      if (answer) return answer
      if (request.pathname === '/api/server/remote-route') return { status: 200, json: request.body }
      if (pathname === '/api/status') return { status: 200, json: { app: 'krobi', version: '1', instanceId: 'nest-1', isInit: true, authMethods: ['token'] } }
      if (pathname === '/api/server/network') return { status: 200, json: { lan: ['http://192.0.2.20:8020'], tailscale: null, externalUrl: null } }
      if (pathname === '/api/me/onboarded') return { status: 200, json: { onboarded: true } }
      if (pathname === '/api/me/username') return { status: 200, json: { username: 'nuevo' } }
      if (pathname.startsWith('/api/me/devices/') && method === 'DELETE') return { status: 200, json: {} }
      if (pathname === '/api/claim') return { status: 201, json: { user: { id: 'u1' }, token: 'tok-1' } }
      if (pathname === '/api/me') return { status: 200, json: { id: 'u1', username: 'robin', isOwner: true, source: 'token' } }
      if (pathname === '/api/server/name') return { status: 200, json: { name: 'Casa Robin' } }
      if (pathname === '/api/library/summary') return { status: 200, json: SUMMARY }
      if (pathname === '/api/listar-albums-con-metadata') return { status: 200, json: [{ album: 'Discovery' }, { album: 'Re' }] }
      if (pathname === '/api/me/devices' && method === 'POST') return { status: 201, json: { device: { id: 'd9', label: 'Teléfono', createdAt: 'x', lastSeenAt: null }, token: 'tok-phone' } }
      if (pathname === '/api/me/devices/app-password') return { status: 201, json: { device: { id: 'd10', label: 'Cliente Subsonic', createdAt: 'x', lastSeenAt: null }, token: 'abcd-efgh-jkmn-pqrs' } }
      if (pathname === '/api/me/devices') return { status: 200, json: { devices: [] } }
      if (pathname === '/api/server/setup') return { status: 200, json: { setupDone: true } }
      return undefined
    },
  })
  const invoke = bridge().invoke
  let stored = signedIn
  restoreInner = setFakeBridgeForTest({
    invoke: (async (channel: string, request: unknown) => {
      if (channel === 'auth:set') {
        stored = true
        return { ok: true }
      }
      if (channel === 'auth:get') return { userId: null, label: null, role: null, hasToken: stored }
      return invoke(channel as never, request as never)
    }) as never,
    on: (() => () => {}) as never,
  })
  return fake
}

function gate(props: Partial<React.ComponentProps<typeof AuthGate>> = {}) {
  return render(
    <DataProvider>
      <AuthGate serverIsInit={false} nestName="Nido de robin" {...props}>
        <p>La biblioteca</p>
      </AuthGate>
    </DataProvider>,
  )
}

async function createAccount() {
  // This helper exercises submission, so fill drafts without per-keystroke timers.
  fireEvent.change(await waitFor(() => screen.getByLabelText('Usuario')), { target: { value: 'robin' } })
  fireEvent.change(screen.getByLabelText('Contraseña'), { target: { value: 'una-contra-larga' } })
  fireEvent.change(screen.getByLabelText('Confirmar contraseña'), { target: { value: 'una-contra-larga' } })
  await user.click(screen.getByRole('button', { name: 'Crear cuenta' }))
}

async function next() { await user.click(await waitFor(() => screen.getByRole('button', { name: 'Siguiente' }))) }
async function skip() { await user.click(await waitFor(() => screen.getByRole('button', { name: 'Omitir' }))) }
async function doneFromMusic() {
  await waitFor(() => screen.getByText('12,340'))
  await next()
  expect(await waitFor(() => screen.getByRole('heading', { name: 'Lejos de casa' }))).toBeInTheDocument()
  await next()
  expect(await waitFor(() => screen.getByRole('heading', { name: 'Motores' }))).toBeInTheDocument()
  await skip()
  expect(await waitFor(() => screen.getByRole('heading', { name: 'Todo listo' }))).toBeInTheDocument()
}

describe('owner flow', () => {
  // Exercises the native relaunch boundary and all six owner onboarding steps.
  it('starts welcome at Nest, then continues after the shell relaunch through account, music, remote, addons and done', async () => {
    const nest = freshNest()
    const view = render(<DataProvider><Onboarding entry="welcome" onFinished={() => {}} /></DataProvider>)
    expect(screen.queryByRole('button', { name: 'Comenzar' })).toBeNull()
    const steps = within(screen.getByRole('list', { name: 'Pasos' })).getAllByRole('listitem')
    expect(steps.map(li => li.querySelector('span')?.textContent)).toEqual(['Nido', 'Cuenta', 'Música', 'Remoto', 'Motores', 'Listo'])
    // Nest selection crosses the native boundary through `server:use`.
    const createHere = screen.queryByRole('button', { name: 'Crear nido aquí' })
    if (createHere) await user.click(createHere)
    else {
      await user.click(screen.getByRole('radio', { name: /En esta computadora/ }))
      await next()
    }
    expect(nest.invokedWith('server:use')).toEqual([{ address: null }])
    view.unmount()
    gate()
    await createAccount()
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Tu música' }))).toBeInTheDocument()
    await doneFromMusic()
    expect(screen.getByText('Solo red local')).toBeInTheDocument()
    expect(screen.getByText('Ninguno')).toBeInTheDocument()
    expect(helper.set).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Nombre del nido')).toHaveValue('Nido de robin')
    fireEvent.change(screen.getByLabelText('Nombre del nido'), { target: { value: 'Casa Robin' } })
    await user.click(screen.getByRole('button', { name: 'Abrir Flipspin' }))
    expect(await waitFor(() => screen.getByText('La biblioteca'))).toBeInTheDocument()
    expect(nest.requests.find(r => r.pathname === '/api/server/name')?.body).toEqual({ name: 'Casa Robin' })
    expect(nest.requests.find(r => r.pathname === '/api/server/setup')?.body).toEqual({ done: true })
    expect(nest.requests.some(r => r.pathname === '/api/me/devices/app-password')).toBe(false)
  }, 20000)

  it('resumes at music, passes albums to Done and uses Nest when the server has no name', async () => {
    freshNest(undefined, true)
    render(<DataProvider><Onboarding entry="resume" onFinished={() => {}} /></DataProvider>)
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Tu música' }))).toBeInTheDocument()
    await doneFromMusic()
    expect(screen.getByLabelText('Nombre del nido')).toHaveValue('Nido')
    expect(screen.getByText('Discovery')).toBeInTheDocument()
    expect(document.querySelector('.kob-tiles > i')).toHaveTextContent('Discovery')
  })

  it('Next with both add-ons selected calls the shared helper switch once', async () => {
    globalThis.__TAURI_INTERNALS__ = {} as never
    freshNest(undefined, true)
    gate({ serverIsInit: true, setupDone: false })
    await waitFor(() => screen.getByText('12,340'))
    await next()
    await next()
    const lyrics = await waitFor(() => screen.getByRole('checkbox', { name: 'Instalar Letras' }))
    await waitFor(() => expect(lyrics).toBeEnabled())
    expect(lyrics).not.toBeChecked()
    await user.click(lyrics)
    expect(screen.getByRole('button', { name: 'Siguiente' })).toBeDisabled()
    expect(screen.getByText(/CC BY-NC 4.0/)).toBeVisible()
    await user.click(screen.getByRole('checkbox', { name: 'Lo usaré solo con fines no comerciales' }))
    await user.click(screen.getByRole('checkbox', { name: 'Instalar Stems' }))
    await next()
    expect(helper.set).toHaveBeenCalledExactlyOnceWith(true)
    expect(await waitFor(() => screen.getByText('Letras, Stems'))).toBeInTheDocument()
  })

  it.each([
    { names: ['Análisis'], summary: 'Análisis' },
    { names: ['Letras', 'Análisis'], summary: 'Letras, Análisis' },
  ])('installs the chosen Analysis target and reviews $summary on Done', async ({ names, summary }) => {
    globalThis.__TAURI_INTERNALS__ = {} as never
    const nest = freshNest(undefined, true)
    gate({ serverIsInit: true, setupDone: false })
    await waitFor(() => screen.getByText('12,340'))
    await next()
    await next()
    for (const name of names) {
      const checkbox = await waitFor(() => screen.getByRole('checkbox', { name: `Instalar ${name}` }))
      await waitFor(() => expect(checkbox).toBeEnabled())
      await user.click(checkbox)
    }
    if (names.includes('Letras')) await user.click(screen.getByRole('checkbox', { name: 'Lo usaré solo con fines no comerciales' }))
    await next()
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Todo listo' }))).toBeVisible()
    expect(screen.getByText(summary)).toBeVisible()
    expect(nest.invokedWith('lyrics:engine-install')).toEqual([{ target: 'analysis' }])
    expect(helper.set).toHaveBeenCalledExactlyOnceWith(true)
  })

  // Revisits four owner setup steps, saves the account and returns through Nest to Done.
  it('editing music, remote, addons and the existing account returns directly to Done', async () => {
    const nest = freshNest(undefined, true)
    gate({ serverIsInit: true, setupDone: false })
    await doneFromMusic()
    await user.click(screen.getByRole('button', { name: 'Cambiar Música' }))
    await waitFor(() => screen.getByText('12,340'))
    await next()
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Todo listo' }))).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cambiar Lejos de casa' }))
    await next()
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Todo listo' }))).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Agregar Motores' }))
    await skip()
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Todo listo' }))).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cambiar Cuenta' }))
    await user.clear(screen.getByLabelText('Usuario'))
    await user.type(screen.getByLabelText('Usuario'), 'nuevo')
    await next()
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Todo listo' }))).toBeInTheDocument()
    expect(nest.requests.find(r => r.pathname === '/api/me/username')?.body).toEqual({ username: 'nuevo' })
    expect(nest.requests.some(r => r.pathname === '/api/claim')).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Cambiar Nido' }))
    expect(screen.queryByRole('heading', { name: 'Todo listo' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Atrás' }))
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Todo listo' }))).toBeInTheDocument()
  }, 20000)

  it('keeps a failed finish inline and retries the same two PUTs', async () => {
    let fail = true
    const nest = freshNest(path => path === '/api/server/setup' && fail ? { status: 500, json: { detail: 'boom' } } : undefined, true)
    gate({ serverIsInit: true, setupDone: false })
    await doneFromMusic()
    await user.click(screen.getByRole('button', { name: 'Abrir Flipspin' }))
    expect(await waitFor(() => screen.getByRole('alert'))).toHaveTextContent('No se pudo guardar la configuración. Reintenta.')
    expect(screen.queryByText('La biblioteca')).toBeNull()
    fail = false
    await user.click(screen.getByRole('button', { name: 'Abrir Flipspin' }))
    expect(await waitFor(() => screen.getByText('La biblioteca'))).toBeInTheDocument()
    expect(nest.requests.filter(r => r.pathname === '/api/server/setup')).toHaveLength(2)
  })

  it('Phone saves first, waits for the app, and opens Your account’s devices', async () => {
    const nest = freshNest(undefined, true)
    function SettingsHost() {
      const request = useSettingsNavigation(() => {})
      return <><nav className="settings-nav">Settings</nav>{request?.section === 'dispositivos' && <h3 id="aj-dispositivos" tabIndex={-1}>My devices</h3>}</>
    }
    function Host() {
      const [finished, setFinished] = useState(false)
      return finished ? <SettingsHost /> : <Onboarding entry="resume" nestName="Nido" onFinished={() => setFinished(true)} />
    }
    render(<DataProvider><Host /></DataProvider>)
    await doneFromMusic()
    const row = screen.getByText('Sin conectar').closest('.kob-row')!
    expect(row).toHaveAttribute('title', 'Una app Subsonic con tu usuario y una contraseña de app · Ajustes → Mis dispositivos. Las apps de Flipspin llegan pronto')
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Conectar' }))
    expect(await waitFor(() => screen.getByText('My devices'))).toBeInTheDocument()
    expect(getRoute().page).toBe('settings')
    await waitFor(() => expect(screen.getByText('My devices')).toHaveFocus())
    expect(nest.requests.filter(r => r.method === 'PUT').map(r => r.pathname)).toEqual(['/api/server/remote-route', '/api/server/name', '/api/server/setup'])
  })

  it('changes only a local nest’s folder with the system picker', async () => {
    const nest = freshNest(path => path === '/api/set-basedir' ? { status: 200, json: {} } : undefined, true)
    pickerHolder.window.desktopAPI = { selectBaseDir: async () => '/selected-music' }
    gate({ serverIsInit: true, setupDone: false, localNest: true })
    const choose = await waitFor(() => screen.getByRole('button', { name: 'Seleccionar' }))
    expect(choose).toHaveAttribute('title', 'Elige otra carpeta de música')
    await user.click(choose)
    await waitFor(() => expect(localStorage.getItem('baseDir')).toBe('/selected-music'))
    expect(nest.requests.find(r => r.pathname === '/api/set-basedir')?.body).toEqual({ basedir: '/selected-music' })
  })
})

describe('member flow', () => {
  function member(extra?: (path: string) => { status: number; json: unknown } | undefined) {
    return freshNest(path => extra?.(path) ?? (path === '/api/me' ? { status: 200, json: { id: 'u2', username: 'ana', isOwner: false, source: 'token', onboarded: false } } : undefined), true)
  }
  it('shows only Devices, skips without minting, and persists per-account completion', async () => {
    const nest = member()
    gate({ serverIsInit: true, setupDone: true })
    expect(await waitFor(() => screen.getByRole('heading', { name: 'Escucha en tu teléfono' }))).toBeInTheDocument()
    expect(screen.getByText('Paso 1 de 1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Atrás' })).toBeNull()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.getByText('App de Flipspin · Próximamente')).toBeInTheDocument()
    expect(screen.getAllByText('Android')).toHaveLength(2)
    expect(screen.getAllByText('iPhone')).toHaveLength(2)
    await skip()
    expect(await waitFor(() => screen.getByText('La biblioteca'))).toBeInTheDocument()
    expect(nest.requests.some(r => r.pathname === '/api/me/onboarded' && r.method === 'POST')).toBe(true)
    expect(nest.requests.some(r => r.pathname === '/api/server/setup')).toBe(false)
    expect(nest.requests.some(r => r.pathname === '/api/me/devices/app-password')).toBe(false)
  })
  it.each(['Omitir', 'Siguiente'])('%s cleans up or retains a generated app password', async action => {
    const nest = member()
    gate({ serverIsInit: true, setupDone: true })
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Generar' })))
    await waitFor(() => screen.getByText('abcd-efgh-jkmn-pqrs'))
    await user.click(screen.getByRole('button', { name: action }))
    await waitFor(() => screen.getByText('La biblioteca'))
    if (action === 'Omitir') await waitFor(() => expect(nest.requests.some(r => r.method === 'DELETE')).toBe(true))
    else expect(nest.requests.some(r => r.method === 'DELETE')).toBe(false)
  })
  it('keeps failed completion inline and retries', async () => {
    let fail = true
    const nest = member(path => path === '/api/me/onboarded' ? { status: fail ? 500 : 200, json: { onboarded: !fail } } : undefined)
    gate({ serverIsInit: true, setupDone: true })
    await skip()
    expect(await waitFor(() => screen.getByRole('alert'))).toHaveTextContent('No se pudo guardar.')
    fail = false
    await skip()
    expect(await waitFor(() => screen.getByText('La biblioteca'))).toBeInTheDocument()
    expect(nest.requests.filter(r => r.pathname === '/api/me/onboarded')).toHaveLength(2)
  })
  it.each([
    { label: 'Chrome en Linux', seen: true, app: false },
    { label: 'iPhone de Ana', seen: true, app: true },
    { label: 'Teléfono', seen: false, app: false },
  ])('preserves member device detection: $label, seen=$seen', async ({ label, seen, app }) => {
    member(path => path === '/api/me/devices' ? { status: 200, json: { devices: [{ id: 'existing', label, lastSeenAt: seen ? '2026-10-27' : null, isCurrent: false }] } } : undefined)
    gate({ serverIsInit: true, setupDone: true })
    if (app) expect(await waitFor(() => screen.getByText('La biblioteca'))).toBeInTheDocument()
    else expect(await waitFor(() => screen.getByText('Paso 1 de 1'))).toBeInTheDocument()
  })
  it('does not repeat completed setup on another device', async () => {
    member(path => path === '/api/me' ? { status: 200, json: { id: 'u2', isOwner: false, source: 'token', onboarded: true } } : undefined)
    gate({ serverIsInit: true, setupDone: true })
    expect(await waitFor(() => screen.getByText('La biblioteca'))).toBeInTheDocument()
  })
})

it('Home shows the local music folder and links to devices and remote when setup was skipped', async () => {
  localStorage.setItem('krobi.setup-remote.nest-1', 'local')
  freshNest(path => path === '/api/library/summary' ? { status: 200, json: { folder: '/music', songs: 0, albums: 0, artists: 0 } } : undefined, true)
  render(<DataProvider><SetupEmptyStates /></DataProvider>)
  const events: unknown[] = []
  const listen = (event: Event) => events.push((event as CustomEvent).detail.section)
  window.addEventListener('krobi-show-settings', listen)
  expect(await waitFor(() => screen.getByText('/music'))).toBeInTheDocument()
  for (const name of [/Emparejar un teléfono/, 'Acceso remoto']) await user.click(await waitFor(() => screen.getByRole('button', { name })))
  window.removeEventListener('krobi-show-settings', listen)
  expect(events).toEqual(['dispositivos', 'remoto'])
})
