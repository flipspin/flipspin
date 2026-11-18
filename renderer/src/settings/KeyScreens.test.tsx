import { clockUser, installTestClock, waitForClock as waitFor } from '../test/test-clock'

import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import config from '../../../contracts/wire/server-config.json'
import { DataProvider } from '../data'
import { installFakeSettings, serverStatus, type FakeSettings, type FakeSettingsOptions } from './test-support'
import type { SecretsStatus, SecretStatus } from '../data/hooks/use-secrets'
import type { IpcInvokeContract } from '../lib/ipc'
import { SettingsPage } from './SettingsPage'
import { DesktopSession } from './sections/DesktopSession'
import SpotifySection from './SpotifySection'
import { __resetLyricsStoreForTest } from '../lyrics/lyricsStore'

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


let fake: FakeSettings | undefined
const clients: QueryClient[] = []
afterEach(() => {
  fake?.restore()
  fake = undefined
  clients.forEach(c => c.clear())
  clients.length = 0
  __resetLyricsStoreForTest()
  vi.restoreAllMocks()
})
const genius = 'KROBI_GENIUS_API_KEY'
function secret(name: string, overrides: Partial<SecretStatus> = {}): SecretStatus {
  return { name, state: 'falta', source: 'app', locked: false, verifiedAt: null, reason: null, ...overrides }
}
function status(overrides: Partial<SecretStatus> = {}): SecretsStatus {
  return { secrets: [secret(genius, overrides), secret('SPOTIFY_CLIENT_ID'), secret('SPOTIFY_CLIENT_SECRET')], key: { fingerprint: '1234abcd', source: 'generated' }, counts: { sources: 0, appPasswords: 0 } }
}
const session: IpcInvokeContract['credentials:describe']['response'] = {
  store: 'macos-keychain', reason: null, nest: { name: 'Nido de prueba', address: 'http://192.0.2.10:8000' },
  deviceName: 'Equipo de prueba', linkedAt: '2026-10-28T12:00:00Z', lastUsed: '2026-11-01T12:00:00Z', state: 'activa',
}
function setup(section: string, options: FakeSettingsOptions = {}, initial = status(), SpotifyKeys?: React.ComponentType) {
  let secrets = initial
  fake = installFakeSettings({ ...options, respond: r => {
    const answer = options.respond?.(r)
    if (answer) return answer
    if (r.pathname === '/api/me') return { status: 200, json: { id: 'owner-fixture', label: 'Cuenta de prueba', isOwner: true, role: 'owner', source: 'token' } }
    if (r.pathname === '/api/providers') return { status: 200, json: { providers: [{ id: 'genius', name: 'Genius', kind: 'lyrics', enabled: true, available: true, capabilities: [] }, { id: 'spotify', name: 'Spotify', kind: 'metadata', enabled: true, available: true, capabilities: [] }] } }
    if (r.pathname === '/api/server/config') return { status: 200, json: config }
    if (r.pathname === '/api/me/devices') return { status: 200, json: { devices: [] } }
    if (r.pathname === '/api/server/secrets') return { status: 200, json: secrets }
    if (r.pathname.startsWith('/api/server/secrets/') && r.method !== 'GET') {
      const name = r.pathname.split('/').at(-1)
      secrets = { ...secrets, secrets: secrets.secrets.map(row => row.name !== name ? row : { ...row, state: r.method === 'DELETE' ? 'falta' : 'guardada', verifiedAt: r.method === 'DELETE' ? null : '2026-11-01T12:00:00Z' }) }
      return { status: 200, json: secrets.secrets.find(row => row.name === name) }
    }
  } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const view = render(<DataProvider queryClient={client}><SettingsPage initialSection={section} surface="app" host={{ SpotifyKeys, palette: 'paper', setPalette: vi.fn(), palettes: [], mode: 'light', setMode: vi.fn() }} /></DataProvider>)
  return { ...view, fake, client, update: (next: SecretsStatus) => { secrets = next } }
}
const keyRow = (label = 'Genius') => within(document.querySelector<HTMLElement>(`[data-source-key="${label}"]`)!)

describe('Source keys in Fuentes', () => {
  it('preserves Spotify account connection without duplicate credential fields', async () => {
    setup('fuentes', { respond: r => r.pathname === '/api/spotify/status' ? { status: 200, json: { configured: true, connected: false } } : undefined }, status(), () => <SpotifySection id="spotify-connection" embedded />)
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Abrir Spotify' })))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Conectar' })).toBeEnabled())
    expect(screen.getByText('Dirección de retorno')).toBeInTheDocument()
    expect(screen.queryByLabelText('Client ID')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Client Secret')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Guardar las claves' })).not.toBeInTheDocument()
  })
  it.each([
    ['guardada', 'Guardada', null], ['falta', 'Falta', null],
    ['rechazada', 'Rechazada', 'provider-rejected'], ['ilegible', 'Ilegible', 'llave-distinta'],
  ] as const)('renders %s as dot and word with reason tooltip', async (state, word, reason) => {
    setup('fuentes', {}, status({ state, reason }))
    await waitFor(() => screen.getByRole('heading', { name: 'Llaves de las fuentes' }))
    await waitFor(() => expect(keyRow().getByText(word)).toBeInTheDocument())
    const mark = keyRow().getByText(word)
    expect(mark.querySelector('.settings-dotw')).not.toBeNull()
    if (reason) expect(mark.title).toContain(reason)
    expect(keyRow('Spotify').getAllByText('Spotify')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Abrir Genius' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Abrir Spotify' })).not.toBeInTheDocument()
  })
  it.each(['env', 'file'] as const)('locked %s has location, variable tooltip and no actions', async source => {
    setup('fuentes', {}, status({ state: 'guardada', source, locked: true }))
    await waitFor(() => screen.getByText('bloqueada'))
    expect(keyRow().queryByRole('button')).not.toBeInTheDocument()
    expect(keyRow().getByText('bloqueada').title).toContain(genius)
    expect(keyRow().getByText(source === 'env' ? 'fijada por el entorno' : 'fijada por un archivo')).toHaveClass('z-mono')
  })
  it('replacing a saved key starts with an empty password field', async () => {
    const view = setup('fuentes', {}, status({ state: 'guardada' }))
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Reemplazar' })))
    expect(keyRow().getByLabelText('Token de acceso')).toHaveValue('')
    expect(view.fake.requests.some(r => r.pathname === '/api/config/genius')).toBe(false)
  })
  it('one locked Spotify credential locks the whole pair', async () => {
    const data = status()
    data.secrets[2] = { ...data.secrets[2], state: 'guardada', source: 'env', locked: true }
    setup('fuentes', {}, data)
    await waitFor(() => screen.getByText('bloqueada'))
    expect(keyRow('Spotify').queryByRole('button')).not.toBeInTheDocument()
  })
  it('a failed status request offers retry without legacy credential forms', async () => {
    let fail = true
    setup('fuentes', { respond: r => r.pathname === '/api/server/secrets' ? fail ? { status: 500, json: { detail: 'unavailable' } } : { status: 200, json: status() } : undefined })
    const section = await waitFor(() => screen.getByRole('region', { name: 'Llaves de las fuentes' }))
    await waitFor(() => within(section).getByRole('alert'))
    fail = false
    await user.click(within(section).getByRole('button', { name: 'Reintentar' }))
    expect(await waitFor(() => within(section).getByText('Genius'))).toBeInTheDocument()
    expect(within(section).queryByText('Deezer')).not.toBeInTheDocument()
  })
  it('saves without fetching stored values, shows verification and removes', async () => {
    const view = setup('fuentes')
    await waitFor(() => expect(document.querySelector('[data-source-key="Genius"]')).not.toBeNull())
    await user.click(keyRow().getByRole('button', { name: 'Guardar' }))
    const input = keyRow().getByLabelText('Token de acceso')
    expect(input).toHaveAttribute('type', 'password')
    expect(input).toHaveValue('')
    await user.type(input, 'fixture-source-secret')
    await user.click(keyRow().getAllByRole('button', { name: 'Guardar' }).at(-1)!)
    await waitFor(() => expect(keyRow().getByText('Verificada')).toBeInTheDocument())
    expect(input).toHaveValue('')
    expect(view.fake.requests.some(r => r.method === 'PUT' && r.pathname.endsWith(genius) && (r.body as { value: string }).value === 'fixture-source-secret')).toBe(true)
    expect(screen.queryByText('fixture-source-secret')).not.toBeInTheDocument()
    await user.click(keyRow().getByRole('button', { name: 'Quitar' }))
    await waitFor(() => expect(keyRow().getByText('Falta')).toBeInTheDocument())
  })
  it.each([['rechazada', 'Rechazada'], ['guardada', 'Pendiente']] as const)('shows verify-on-save result %s', async (state, word) => {
    let current = status()
    setup('fuentes', { respond: r => {
      if (r.pathname.endsWith(genius) && r.method === 'PUT') {
        current = status({ state, reason: state === 'rechazada' ? 'provider-rejected' : null })
        return { status: 200, json: current.secrets[0] }
      }
      if (r.pathname === '/api/server/secrets') return { status: 200, json: current }
    } })
    await waitFor(() => expect(document.querySelector('[data-source-key="Genius"]')).not.toBeNull())
    await user.click(keyRow().getByRole('button', { name: 'Guardar' }))
    await user.type(keyRow().getByLabelText('Token de acceso'), 'fixture-key')
    await user.click(keyRow().getAllByRole('button', { name: 'Guardar' }).at(-1)!)
    await waitFor(() => expect(keyRow().getByText(word, { selector: '.settings-source-form__actions .settings-word' })).toBeInTheDocument())
  })
  it('saves both Spotify credentials with one request and locks the combined row', async () => {
    let current = status()
    const view = setup('fuentes', { respond: r => {
      if (r.pathname === '/api/server/secrets') return { status: 200, json: current }
      if (r.pathname === '/api/config/spotify' && r.method === 'PUT') {
        current = { ...current, secrets: current.secrets.map(row => row.name.startsWith('SPOTIFY_') ? { ...row, state: 'guardada', verifiedAt: '2026-11-01T00:00:00Z' } : row) }
        return { status: 200, json: { configured: true } }
      }
    } })
    await waitFor(() => expect(document.querySelector('[data-source-key="Genius"]')).not.toBeNull())
    await user.click(keyRow('Spotify').getByRole('button', { name: 'Guardar' }))
    await user.type(keyRow('Spotify').getByLabelText('ID de cliente'), 'fixture-client')
    await user.type(keyRow('Spotify').getByLabelText('Secreto de cliente'), 'fixture-secret')
    await user.click(keyRow('Spotify').getAllByRole('button', { name: 'Guardar' }).at(-1)!)
    await waitFor(() => expect(keyRow('Spotify').getByText('Verificada')).toBeInTheDocument())
    expect(view.fake.requests.filter(r => r.pathname === '/api/config/spotify')).toHaveLength(1)
    expect(view.fake.requests.find(r => r.pathname === '/api/config/spotify')?.body).toEqual({ client_id: 'fixture-client', client_secret: 'fixture-secret' })
  })
  it('missing server values use Missing and cookies are not invented as a stored secret', async () => {
    const data = status()
    data.secrets = []
    setup('fuentes', {}, data)
    await waitFor(() => expect(document.querySelector('[data-source-key="Genius"]')).not.toBeNull())
    expect(keyRow('Genius').queryByText('Falta')).not.toBeInTheDocument()
    expect(keyRow('Genius').getByText('Sin datos', { exact: false })).toBeInTheDocument()
    expect(document.querySelector('[data-source-key="YouTube"]')).not.toBeInTheDocument()
  })
})

describe('Desktop session in Mi cuenta', () => {
  it.each([
    ['macos-keychain', 'Llavero de macOS'], ['windows-credential-manager', 'Administrador de credenciales de Windows'],
    ['secret-service', 'Llavero del sistema'], ['file', 'Archivo en este equipo'], ['memory', 'Solo en memoria hasta cerrar Flipspin'],
  ] as const)('shows %s storage and metadata', async (store, label) => {
    setup('cuenta', { session: { ...session, store } })
    const section = await waitFor(() => screen.getByRole('region', { name: 'Sesión en este equipo' }))
    await waitFor(() => within(section).getByText(label))
    expect(section).toHaveTextContent('Nido de prueba')
    expect(section).toHaveTextContent('Equipo de prueba')
    expect(within(section).getByText('Activa').querySelector('.settings-dotw')).not.toBeNull()
    expect(section.textContent).not.toMatch(/token/i)
  })
  it.each([['rechazada', 'Rechazada por el nido'], ['sin-conexion', 'Sin conexión']] as const)('shows %s', async (state, label) => {
    setup('cuenta', { session: { ...session, state } })
    expect(await waitFor(() => screen.getByText(label))).toBeInTheDocument()
  })
  it('memory notice appears once, saves explicitly and updates storage', async () => {
    const view = setup('cuenta', { session: { ...session, store: 'memory', reason: 'keyring-unavailable' } })
    const notice = await waitFor(() => screen.getByText('No hay llavero del sistema · la sesión dura hasta cerrar Flipspin'))
    expect(notice.title).toBe('keyring-unavailable')
    expect(screen.getAllByText(notice.textContent!)).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Guardar en un archivo de este equipo' }))
    expect(await waitFor(() => screen.getByText('Archivo en este equipo'))).toBeInTheDocument()
    expect(screen.queryByText(notice.textContent!)).not.toBeInTheDocument()
    expect(view.fake.invokedWith('credentials:save-to-file')).toHaveLength(1)
  })
  it('failed file save keeps memory notice and offers retry', async () => {
    setup('cuenta', { session: { ...session, store: 'memory' }, saveSession: () => ({ ok: false, store: 'file' }) })
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Guardar en un archivo de este equipo' })))
    expect(await waitFor(() => screen.getByText('No se pudo guardar la sesión'))).toBeInTheDocument()
    expect(screen.getByText('Solo en memoria hasta cerrar Flipspin')).toBeInTheDocument()
  })
  it('opens existing sign-out and devices controls', async () => {
    const view = setup('cuenta', { session })
    const section = await waitFor(() => screen.getByRole('region', { name: 'Sesión en este equipo' }))
    await user.click(await waitFor(() => within(section).getByRole('button', { name: 'Ver dispositivos' })))
    await waitFor(() => expect(document.activeElement?.id).toBe('aj-dispositivos'))
    expect(document.querySelector('.settings')).toHaveAttribute('data-page', 'dispositivos')
    await user.click(screen.getByRole('button', { name: 'Mi cuenta' }))
    const accountSession = await waitFor(() => screen.getByRole('region', { name: 'Sesión en este equipo' }))
    await user.click(within(accountSession).getByRole('button', { name: 'Cerrar sesión' }))
    const dialog = await waitFor(() => screen.getByRole('dialog', { name: '¿Cerrar sesión en este equipo?' }))
    await user.click(within(dialog).getByRole('button', { name: 'Cerrar sesión' }))
    await waitFor(() => expect(view.fake.invokedWith('auth:clear')).toHaveLength(1))
  })
  it('is absent outside the bridge', () => {
    const client = new QueryClient()
    clients.push(client)
    const view = render(<DataProvider queryClient={client}><DesktopSession onDevices={vi.fn()} onSignOut={vi.fn()} /></DataProvider>)
    expect(view.container).toBeEmptyDOMElement()
  })
})

describe('Nest key in Security', () => {
  it.each([['generated', 'Generada en el nido'], ['key-file', 'Archivo de llave'], ['credentials-dir', 'Llavero de este equipo']] as const)('shows %s and counts from status', async (source, label) => {
    setup('security', {}, { ...status(), key: { fingerprint: '1234abcd', source }, counts: { sources: 3, appPasswords: 2 } })
    expect(await waitFor(() => screen.getByText(label))).toBeInTheDocument()
    expect(screen.getByText('1234abcd')).toHaveClass('z-mono')
    expect(screen.getByText('3 de fuentes · 2 contraseñas de apps')).toBeInTheDocument()
  })
  it('a separate server credential is not labelled as the desktop keychain', async () => {
    setup('security', { status: serverStatus({ mode: 'external', ownedByUs: false }) }, { ...status(), key: { fingerprint: '1234abcd', source: 'credentials-dir' } })
    expect(await waitFor(() => screen.getByText('Credencial del sistema'))).toBeInTheDocument()
    expect(screen.queryByText('Llavero de este equipo')).not.toBeInTheDocument()
  })
  it('unknown fingerprint and app password count use Missing', async () => {
    setup('security', {}, { ...status(), key: { fingerprint: null, source: 'generated' }, counts: { sources: 1, appPasswords: null } })
    await waitFor(() => screen.getByText('1 de fuentes', { exact: false }))
    const section = screen.getByRole('region', { name: 'Llave del nido' })
    expect(within(section).getByRole('button', { name: 'Descargar llave' })).toBeDisabled()
    expect(within(section).getAllByText('Sin datos', { exact: false })).toHaveLength(2)
  })
  it('exports only after password submission, saves through native file picker', async () => {
    const view = setup('security', { respond: r => r.pathname === '/api/server/secrets/key/export' ? { status: 200, text: 'fixture-key-ring' } : undefined })
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Descargar llave' })))
    const dialog = await waitFor(() => screen.getByRole('dialog', { name: 'Descargar llave' }))
    expect(view.fake.requests.filter(r => r.method === 'POST')).toHaveLength(0)
    const input = within(dialog).getByLabelText('Contraseña')
    expect(input).toHaveAttribute('type', 'password')
    fireEvent.change(input, { target: { value: 'fixture-password' } })
    await user.click(within(dialog).getByRole('button', { name: 'Descargar llave' }))
    await waitFor(() => expect(view.fake.invokedWith('files:save-key-export')).toEqual([{ name: 'krobi-nido-1234abcd.key', contents: 'fixture-key-ring' }]), { timeout: 5000 })
    expect(await waitFor(() => screen.getByText('Llave descargada', {}))).toBeInTheDocument()
    expect(screen.queryByText('fixture-key-ring')).not.toBeInTheDocument()
    expect(view.fake.requests.find(r => r.pathname.endsWith('/key/export'))?.body).toEqual({ password: 'fixture-password' })
    expect(view.client.getMutationCache().getAll().every(m => m.state.variables === undefined)).toBe(true)
  }, 20_000)
  it.each([
    [401, 'incorrect-password', 'La contraseña es incorrecta'],
    [409, 'account-password-required', 'Esta sesión no tiene una cuenta con contraseña'],
    [409, 'llave-distinta', 'La llave del nido es ilegible'],
    [429, 'password-rate-limited', 'Espera antes de volver a intentar'],
    [403, 'forbidden', 'No se pudo descargar la llave'],
  ] as const)('handles %s %s without saving', async (code, detail, message) => {
    const view = setup('security', { respond: r => r.pathname.endsWith('/key/export') ? { status: code, json: { detail } } : undefined })
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Descargar llave' })))
    const dialog = await waitFor(() => screen.getByRole('dialog'))
    const input = within(dialog).getByLabelText('Contraseña')
    fireEvent.change(input, { target: { value: 'fixture-password' } })
    await user.click(within(dialog).getByRole('button', { name: 'Descargar llave' }))
    expect(await waitFor(() => screen.getByText(message))).toBeInTheDocument()
    expect(input).toHaveValue('')
    expect(view.fake.invokedWith('files:save-key-export')).toHaveLength(0)
  })
  it('cancel before submit makes no export request', async () => {
    const view = setup('security')
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Descargar llave' })))
    await user.click(within(await waitFor(() => screen.getByRole('dialog'))).getByRole('button', { name: 'Cancelar' }))
    expect(view.fake.requests.filter(r => r.pathname.endsWith('/key/export'))).toHaveLength(0)
  })
  it.each([true, false])('native save cancelled=%s does not announce a download', async cancelled => {
    setup('security', {
      saveKeyExport: () => ({ ok: cancelled, cancelled }),
      respond: r => r.pathname.endsWith('/key/export') ? { status: 200, text: 'fixture-ring' } : undefined,
    })
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Descargar llave' })))
    const dialog = await waitFor(() => screen.getByRole('dialog'))
    fireEvent.change(within(dialog).getByLabelText('Contraseña'), { target: { value: 'fixture-password' } })
    await user.click(within(dialog).getByRole('button', { name: 'Descargar llave' }))
    if (cancelled) await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument(), { timeout: 5000 })
    else expect(await waitFor(() => screen.getByText('No se pudo descargar la llave', {}))).toBeInTheDocument()
    expect(screen.queryByText('Llave descargada')).not.toBeInTheDocument()
  }, 20_000)
})
