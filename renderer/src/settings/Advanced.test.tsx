import { clockUser, installTestClock, waitForClock as waitFor } from '../test/test-clock'

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import fixture from '../../../contracts/wire/server-config.json'
import { DataProvider } from '../data'
import { installFakeSettings, type FakeSettings, type RecordedRequest, type ResponseSpec } from './test-support'
import { SettingsPage } from './SettingsPage'
import { CAPACITY_KEYS, type ServerConfig } from './config'
import { __resetLyricsStoreForTest } from '../lyrics/lyricsStore'

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


let fake: FakeSettings | undefined
const clients: QueryClient[] = []
afterEach(() => {
  fake?.restore()
  clients.forEach((c) => c.clear())
  clients.length = 0
  __resetLyricsStoreForTest()

})
function setup(options: { admin?: boolean; config?: ServerConfig; respond?: (r: RecordedRequest) => ResponseSpec | undefined; section?: string } = {}) {
  let config = options.config ?? structuredClone(fixture) as ServerConfig
  rows(config).find(row => row.key === 'KROBI_ADVERTISE')!.needsRestart = true
  fake = installFakeSettings({ respond: (r) => {
    const custom = options.respond?.(r)
    if (custom) return custom
    if (r.pathname === '/api/me') return { status: 200, json: { id: 'u1', label: 'Prueba', isOwner: options.admin !== false, role: options.admin === false ? 'member' : 'owner', source: 'token' } }
    if (r.pathname === '/api/status') return { status: 200, json: { app: 'krobi', restarting: false } }
    if (r.pathname === '/api/server/config') {
      if (r.method === 'PUT') {
        const changes = (r.body as { changes: Record<string, unknown> }).changes
        for (const row of config.groups.flatMap((g) => g.settings)) if (row.key in changes) {
          row.source = 'app'
          if (row.needsRestart) {
            row.pendingValue = changes[row.key]
            config.restart.pending = row.pendingValue === row.value ? [] : [row.key]
          } else row.value = changes[row.key]
        }
      }
      return { status: 200, json: config }
    }
    if (r.pathname === '/api/server/restart') return { status: 202, json: { restarting: true, when: (r.body as { when: string }).when } }
  } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const view = render(<DataProvider queryClient={client}><SettingsPage initialSection={options.section ?? 'performance'} surface="app" host={{ vlcIp: '', setVlcIp: vi.fn(), palette: 'paper', setPalette: vi.fn(), palettes: [], mode: 'light', setMode: vi.fn() }} /></DataProvider>)
  return { ...view, fake, client, getConfig: () => config, setConfig: (next: ServerConfig) => { config = next } }
}
const rows = (config: ServerConfig) => config.groups.flatMap((g) => g.settings)
const rowIn = (key: string) => document.querySelector<HTMLElement>(`[data-config-key="${key}"]`)!
const ready = () => waitFor(() => screen.getByRole('slider', { name: 'A la vez por fuente' }))
const network = async () => { await user.click(await waitFor(() => within(screen.getByRole('navigation')).getByRole('button', { name: /^Red/ }))); await waitFor(() => screen.getByRole('switch', { name: 'Visible en tu red' })) }
const secondary = async () => { await network(); await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'Abrir' })) }
const writes = () => fake.requests.filter((r) => r.pathname === '/api/server/config' && r.method === 'PUT')
function pendingConfig(): ServerConfig {
  const config = structuredClone(fixture) as ServerConfig
  config.restart.pending = ['KROBI_ADVERTISE']
  const engine = rows(config).find((r) => r.key === 'KROBI_ADVERTISE')!
  engine.pendingValue = false
  config.activity = { downloads: 2, jobs: 1, devicesSeen5min: 3 }
  return config
}

it('retires the moved compute controls from the secondary settings', async () => {
  setup()
  await secondary()
  for (const key of ['KROBI_NEST_PROCESSES', 'KROBI_LYRICS_ENGINE', 'KROBI_STEMS_BACKGROUND', 'KROBI_ANALYSIS_WORKERS']) expect(rowIn(key)).toBeNull()
})

it('shows the four security rows beside the nest key with explanations only in tooltips', async () => {
  setup({ section: 'security' })
  await waitFor(() => expect(rowIn('KROBI_REQUIRE_SETUP_TOKEN')).not.toBeNull())
  expect(screen.getByRole('region', { name: 'Llave del nido' })).toBeVisible()
  for (const key of ['KROBI_REQUIRE_SETUP_TOKEN', 'KROBI_API_TOKEN', 'KROBI_ALLOW_UNAUTHENTICATED_REMOTE', 'KROBI_ALLOW_REMOTE_LOCAL_ACTIONS']) {
    expect(rowIn(key)).toBeVisible()
    expect(rowIn(key).querySelector('.settings-tipped')).toHaveAttribute('title')
  }
  expect(screen.getByText('Acceso sin una cuenta')).toBeVisible()
  expect(screen.getByText('Abrir archivos desde otro equipo')).toHaveAttribute('title', expect.stringContaining('Otro equipo puede pedirle al nido'))
  await user.click(screen.getByRole('heading', { name: 'Seguridad', level: 2 }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('opens Advanced only from the visible row and excludes security settings', async () => {
  setup({ section: 'network' })
  await waitFor(() => screen.getByRole('switch', { name: 'Visible en tu red' }))
  for (const heading of screen.getAllByRole('heading', { name: 'Red' })) await user.click(heading)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(within(screen.getByRole('main')).queryByRole('button', { name: 'Red' })).not.toBeInTheDocument()
  expect(screen.getByText('Avanzado')).toHaveAttribute('title', 'Detalle del registro, páginas web permitidas y cabeceras del proxy')
  await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'Abrir' }))
  const dialog = screen.getByRole('dialog', { name: 'Avanzado' })
  expect(within(dialog).getByText('Detalle del registro')).toBeVisible()
  expect(rowIn('KROBI_CORS_ORIGINS')).toBeVisible()
  for (const key of ['KROBI_REQUIRE_SETUP_TOKEN', 'KROBI_API_TOKEN', 'KROBI_ALLOW_UNAUTHENTICATED_REMOTE', 'KROBI_ALLOW_REMOTE_LOCAL_ACTIONS']) expect(rowIn(key)).toBeNull()
})

it('shows source cookies inside Sources → Audio', async () => {
  setup({ section: 'sources-audio', respond: request => {
    if (request.pathname === '/api/providers') return { status: 200, json: { providers: [
      { id: 'youtube', name: 'YouTube', kind: 'streaming', capabilities: ['stream'] },
      { id: 'lrclib', name: 'LRCLIB', kind: 'lyrics', capabilities: ['lyrics'] },
    ] } }
    if (request.pathname === '/api/config/ytdlp-cookies') return { status: 200, json: { cookies_from_browser: '', cookies_file: '' } }
  } })
  await user.click(await waitFor(() => screen.getByRole('button', { name: 'Abrir YouTube' })))
  expect(await screen.findByRole('combobox', { name: 'Navegador' })).toBeVisible()
  expect(screen.queryByText('LRCLIB')).not.toBeInTheDocument()
})

describe('Configuración — real bridge seam and fetch boundary', () => {
  it('keeps Status and Log under System', async () => {
    setup()
    await ready()
    const buttons = within(screen.getByRole('navigation', { name: 'Secciones de ajustes' })).getAllByRole('button')
    expect(buttons.slice(-2).map(button => button.textContent)).toEqual(['Estado', 'Registro'])
    expect(screen.getByText('Sistema')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Rendimiento' })).toBeInTheDocument()
  })
  it.each(['performance', 'network', 'security'])('shows only the %s block on its page', async section => {
    setup({ section })
    await waitFor(() => expect(document.querySelector('.settings-skel')).not.toBeInTheDocument())
    expect(screen.queryAllByRole('slider')).toHaveLength(section === 'performance' ? 2 : 0)
    expect(screen.queryAllByRole('region', { name: 'Llave del nido' })).toHaveLength(section === 'security' ? 1 : 0)
    expect(screen.queryAllByRole('switch', { name: 'Visible en tu red' })).toHaveLength(section === 'network' ? 1 : 0)
  })
  it('dismisses the secondary dialog with Escape and restores focus to the visible Advanced control', async () => {
    setup({ section: 'network' })
    await secondary()
    expect(screen.getByRole('dialog', { name: 'Avanzado' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(within(screen.getByRole('main')).getByRole('button', { name: 'Abrir' })).toHaveFocus()
    expect(screen.getByRole('heading', { name: 'Red', level: 2 })).toBeInTheDocument()
  })
  it('shows ffmpeg path, version and binary source and saves the owner path live', async () => {
    setup()
    await secondary()
    expect(screen.getByLabelText('ffmpeg')).toHaveValue('/usr/bin/ffmpeg')
    expect(screen.getByText('ffmpeg')).toHaveAttribute('title', expect.stringContaining('Versión de ffmpeg · 7.1'))
    expect(screen.getByText('ffmpeg')).toHaveAttribute('title', expect.stringContaining('Origen de ffmpeg · Del sistema'))
    const input = screen.getByLabelText('ffmpeg')
    fireEvent.change(input, { target: { value: '/custom/ffmpeg' } })
    fireEvent.blur(input)
    await waitFor(() => screen.getByText('Guardado'))
    expect(writes().at(-1).body).toEqual({ changes: { KROBI_FFMPEG_PATH: '/custom/ffmpeg' } })
    expect(screen.getByLabelText('ffmpeg')).toHaveValue('/custom/ffmpeg')
    expect(rowIn('KROBI_FFMPEG_PATH').querySelector('.settings-restartmark')).not.toBeInTheDocument()
  })
  it('shows a bad ffmpeg path error and keeps a process-env path locked', async () => {
    const { unmount } = setup({ respond: (r) => r.method === 'PUT' ? { status: 422, json: { detail: { code: 'invalid-ffmpeg', key: 'KROBI_FFMPEG_PATH' } } } : undefined })
    await secondary()
    fireEvent.change(screen.getByLabelText('ffmpeg'), { target: { value: '/bad' } })
    fireEvent.blur(screen.getByLabelText('ffmpeg'))
    await waitFor(() => expect(screen.getByText('ffmpeg')).toHaveAttribute('title', expect.stringContaining('La ruta no contiene un ffmpeg que se pueda ejecutar.')))
    unmount()
    fake?.restore()
    const config = structuredClone(fixture) as ServerConfig
    const row = rows(config).find((r) => r.key === 'KROBI_FFMPEG_PATH')!
    row.source = 'env'; row.editable = false; row.binarySource = 'env'
    setup({ config })
    await secondary()
    expect(screen.queryByRole('textbox', { name: 'ffmpeg' })).not.toBeInTheDocument()
    expect(rowIn('KROBI_FFMPEG_PATH')).toHaveTextContent('/usr/bin/ffmpeg')
    expect(rowIn('KROBI_FFMPEG_PATH')).toHaveTextContent('del nido')
    expect(screen.getByText('ffmpeg')).toHaveAttribute('title', expect.stringContaining('Origen de ffmpeg · Ruta configurada'))
  })
  it.each(['config', 'performance', 'network', 'security'])('hides %s from a normal account; never fetches config', async section => {
    setup({ admin: false, section })
    await waitFor(() => screen.getByRole('heading', { name: 'Resumen', level: 2 }))
    for (const name of ['Rendimiento', 'Red', 'Seguridad']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    expect(fake.requests.some((r) => r.pathname === '/api/server/config')).toBe(false)
  })
  it.each([['Ligero', [1, 1]], ['Normal', [2, 2]]] as const)('preset %s saves only the two active values atomically and offers undo', async (name, values) => {
    setup()
    await ready()
    expect(rowIn('KROBI_ANALYSIS_WORKERS')).toBeNull()
    expect(screen.getAllByRole('radio')).toHaveLength(3)
    expect(screen.queryByRole('radio', { name: /Potente/ })).not.toBeInTheDocument()
    expect(screen.getByText('sugerido')).toBeVisible()
    const preset = screen.getByRole('radio', { name: new RegExp(name) })
    expect(preset.querySelectorAll('.settings-preset__n > span')).toHaveLength(2)
    await user.click(preset)
    await waitFor(() => expect(writes()).toHaveLength(1))
    expect(writes()[0].body).toEqual({ changes: Object.fromEntries(CAPACITY_KEYS.map((key, i) => [key, values[i]])) })
    await waitFor(() => screen.getByText('Guardado'))
    CAPACITY_KEYS.forEach((key, i) => expect(within(rowIn(key)).getByRole('slider')).toHaveValue(String(values[i])))
    await user.click(screen.getByRole('button', { name: 'Deshacer' }))
    await waitFor(() => expect(writes()).toHaveLength(2))
    expect(writes()[1].body).toEqual({ changes: Object.fromEntries(CAPACITY_KEYS.map((key, i) => [key, [3, 2, 2][i]])) })
  })
  it('labels the per-source slider with bounds 1–4 and keeps jobs at a time', async () => {
    setup()
    const slider = await ready()
    expect(slider).toHaveAttribute('min', '1')
    expect(slider).toHaveAttribute('max', '4')
    expect(screen.getByRole('slider', { name: 'Trabajos a la vez' })).toBeVisible()
    expect(rowIn(CAPACITY_KEYS[0]).querySelector('.settings-tipped')).toHaveAttribute('title', expect.stringContaining('de cada fuente'))
  })
  it('marks the suggested range and warns above it without blocking the save', async () => {
    setup()
    fireEvent.change(await ready(), { target: { value: '4' } })
    fireEvent.pointerUp(await ready())
    await waitFor(() => expect(within(rowIn(CAPACITY_KEYS[0])).getByText('A la vez por fuente')).toHaveAttribute('title', expect.stringContaining('más de lo recomendado para este equipo')))
    expect(screen.getByText('Personalizado')).toBeInTheDocument()
    expect(within(rowIn(CAPACITY_KEYS[0])).getByRole('slider')).toHaveValue('4')
    expect(rowIn(CAPACITY_KEYS[0]).style.getPropertyValue('--_sug')).toBe(String(1 / 3))
  })
  it('previews a dragged slider and commits only its final value', async () => {
    setup()
    const slider = await ready()
    fireEvent.change(slider, { target: { value: '3' } })
    fireEvent.change(slider, { target: { value: '2' } })
    fireEvent.change(slider, { target: { value: '4' } })
    expect(writes()).toHaveLength(0)
    expect(within(rowIn(CAPACITY_KEYS[0])).getByText('A la vez por fuente')).toHaveAttribute('title', expect.stringContaining('más de lo recomendado para este equipo'))
    fireEvent.pointerUp(slider)
    await waitFor(() => screen.getByText('Guardado'))
    expect(writes()).toHaveLength(1)
    expect(writes()[0].body).toEqual({ changes: { [CAPACITY_KEYS[0]]: 4 } })
  })
  it('locks an env-pinned editable key and disables presets that would change it', async () => {
    const config = structuredClone(fixture) as ServerConfig
    rows(config)[0].source = 'env'
    rows(config)[0].editable = false
    setup({ config })
    expect(await ready()).toBeDisabled()
    expect(within(rowIn(CAPACITY_KEYS[0])).getByText('A la vez por fuente')).toHaveAttribute('title', expect.stringContaining('del nido'))
    expect(screen.getByRole('radio', { name: /Ligero/ })).toBeDisabled()
  })
  it('never renders a secret value, length or default, even from a bad fixture', async () => {
    const config = structuredClone(fixture) as ServerConfig
    const secret = rows(config).find((r) => r.secret)!
    secret.value = 'never-display-this'
    secret.default = 'never-display-default'
    secret.configured = true
    setup({ config })
    await user.click(await waitFor(() => within(screen.getByRole('navigation')).getByRole('button', { name: 'Seguridad' })))
    await waitFor(() => screen.getByRole('heading', { level: 3, name: 'Seguridad' }))
    expect(within(rowIn(secret.key)).getByText('configurada')).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain('never-display')
    expect(within(rowIn(secret.key)).queryByRole('textbox')).not.toBeInTheDocument()
  })
  it.each([
    ['out-of-range', 'Entre 1 y 16.'], ['not-a-choice', 'Elige una de las opciones disponibles.'],
    ['bad-type', 'El valor no tiene el formato esperado.'], ['unknown-key', 'Este nido no admite este ajuste.'],
    ['env-locked', 'Se configura en el archivo del nido.'], ['read-only', 'Este valor no se puede cambiar aquí.'],
    ['write-failed', 'No se pudo guardar en el nido. El valor no cambió.'],
  ])('places %s words on its own row and keeps the saved value', async (code, words) => {
    setup({ respond: (r) => r.method === 'PUT' ? { status: code === 'write-failed' ? 500 : code === 'env-locked' || code === 'read-only' ? 409 : 422, json: { detail: { code, key: CAPACITY_KEYS[0], min: 1, max: 16 } } } : undefined })
    fireEvent.change(await ready(), { target: { value: '4' } })
    fireEvent.pointerUp(await ready())
    await waitFor(() => expect(within(rowIn(CAPACITY_KEYS[0])).getByText('A la vez por fuente')).toHaveAttribute('title', expect.stringContaining(words)))
    expect(within(rowIn(CAPACITY_KEYS[0])).getByRole('slider')).toHaveValue('3')
    expect(screen.queryByText('Guardado')).not.toBeInTheDocument()
  })
  it('an atomic preset failure changes none of its sliders', async () => {
    setup({ respond: (r) => r.method === 'PUT' ? { status: 422, json: { detail: { code: 'bad-type', key: CAPACITY_KEYS[1] } } } : undefined })
    await ready()
    await user.click(screen.getByRole('radio', { name: /Normal/ }))
    await waitFor(() => expect(rowIn(CAPACITY_KEYS[1]).querySelector('.settings-tipped')).toHaveAttribute('title', expect.stringContaining('El valor no tiene el formato esperado.')))
    CAPACITY_KEYS.forEach((key, i) => expect(within(rowIn(key)).getByRole('slider')).toHaveValue(String([3, 2, 2][i])))
  })
  it('saving a restart key shows running → pending, the bar, nav count and Resumen row', async () => {
    setup()
    await network()
    await user.click(screen.getByRole('switch', { name: 'Visible en tu red' }))
    await waitFor(() => screen.getByText('Reinicia el nido para aplicar 1 cambio'))
    expect(rowIn('KROBI_ADVERTISE').querySelector('.settings-tipped')).toHaveAttribute('title', expect.stringContaining('al reiniciar'))
    const nav = screen.getByRole('navigation', { name: 'Secciones de ajustes' })
    expect(within(nav).getByRole('button', { name: /Rendimiento/ })).toHaveTextContent('1')
    await user.click(within(nav).getByRole('button', { name: 'Resumen' }))
    expect(await waitFor(() => screen.getByText('Reinicia el nido para aplicar 1 cambio'))).toBeInTheDocument()
  })
  it.each(['performance', 'network', 'security'].flatMap(section => ['idle', 'now'].map(when => [section, when])))('restart dialog from %s names impacts and sends %s; idle is default', async (section, when) => {
    setup({ section, config: pendingConfig() })
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Reiniciar…' })))
    const dialog = screen.getByRole('dialog', { name: '¿Reiniciar el nido?' })
    expect(within(dialog).getByRole('radio', { name: 'Al terminar las descargas' })).toHaveAttribute('aria-checked', 'true')
    expect(within(dialog).getByText('Espera a 2 descargas en curso')).toBeInTheDocument()
    expect(within(dialog).getByText('Espera a 1 trabajo en curso')).toBeInTheDocument()
    expect(within(dialog).getByText('3 dispositivos conectados vuelven solos en unos segundos')).toBeInTheDocument()
    if (when === 'now') {
      await user.click(within(dialog).getByRole('radio', { name: 'Ahora' }))
      expect(within(dialog).getByText('2 descargas en curso se cortan')).toBeInTheDocument()
    }
    await user.click(within(dialog).getByRole('button', { name: when === 'now' ? 'Reiniciar ahora' : 'Reiniciar al terminar' }))
    await waitFor(() => screen.getAllByText('Reiniciando el nido…'))
    expect(fake.requests.find((r) => r.pathname === '/api/server/restart').body).toEqual({ when })
    expect(screen.queryByRole('dialog', { name: '¿Reiniciar el nido?' })).not.toBeInTheDocument()
  })
  it('keeps a rejected restart in the dialog with a reason and permits retry', async () => {
    let fail = true
    setup({ config: pendingConfig(), respond: (r) => r.pathname === '/api/server/restart' && fail ? { status: 503, json: { detail: 'busy' } } : undefined })
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Reiniciar…' })))
    await user.click(screen.getByRole('button', { name: 'Reiniciar al terminar' }))
    expect(await waitFor(() => screen.getByRole('alert'))).toHaveTextContent('No se pudo reiniciar el nido. Vuelve a intentarlo.')
    fail = false
    await user.click(screen.getByRole('button', { name: 'Reiniciar al terminar' }))
    await waitFor(() => screen.getAllByText('Reiniciando el nido…'))
    expect(screen.queryByRole('dialog', { name: '¿Reiniciar el nido?' })).not.toBeInTheDocument()
  })
  it('saving a restart value back to the running value clears the bar and badge', async () => {
    setup({ config: pendingConfig() })
    await network()
    await user.click(screen.getByRole('switch', { name: 'Visible en tu red' }))
    await waitFor(() => screen.getByText('Guardado'))
    expect(screen.queryByRole('button', { name: 'Reiniciar…' })).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: 'Secciones de ajustes' }).querySelector('.settings-nav__badge')).not.toBeInTheDocument()
  })
  it('an unsupervised nest offers its own copyable command and never calls restart', async () => {
    const clipboard = clockUser()
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue()
    const config = pendingConfig()
    config.restart = { ...config.restart, supported: false, how: 'none', command: 'python -m app' }
    setup({ config })
    await clipboard.click(await waitFor(() => screen.getByRole('button', { name: 'Reiniciar…' })))
    const dialog = screen.getByRole('dialog', { name: '¿Reiniciar el nido?' })
    expect(within(dialog).getByText('python -m app')).toBeInTheDocument()
    expect(within(dialog).queryByRole('radio')).not.toBeInTheDocument()
    await clipboard.click(within(dialog).getByRole('button', { name: 'Copiar' }))
    expect(copy).toHaveBeenCalledWith('python -m app')
    expect(fake.requests.some((r) => r.pathname === '/api/server/restart')).toBe(false)
  })
  it('reconnects after a restart outage, clears the bar and refreshes status without remounting', async () => {
    let restarting = false
    let offline = false
    const { client, setConfig } = setup({ config: pendingConfig(), respond: (r) => {
      if (r.pathname === '/api/status') return offline ? { networkError: 'offline' } : { status: 200, json: { restarting } }
      if (r.pathname === '/api/server/config' && offline) return { networkError: 'offline' }
    } })
    await user.click(await waitFor(() => screen.getByRole('button', { name: 'Reiniciar…' })))
    await user.click(screen.getByRole('button', { name: 'Reiniciar al terminar' }))
    await waitFor(() => screen.getAllByText('Reiniciando el nido…'))
    restarting = true
    await act(() => client.refetchQueries({ queryKey: ['server', 'config-status'] }))
    offline = true
    await act(() => client.refetchQueries({ queryKey: ['server', 'config-status'] }))
    expect(screen.getAllByText('Reiniciando el nido…').length).toBeGreaterThan(0)
    expect(screen.getByRole('heading', { name: 'Rendimiento', level: 2 })).toBeInTheDocument()
    offline = false
    restarting = false
    const config = pendingConfig(); config.restart.pending = []
    rows(config).find((r) => r.key === 'KROBI_ADVERTISE')!.value = false
    setConfig(config)
    // Completion compares response timestamps with the restart request.
    await act(() => vi.advanceTimersByTimeAsync(1))
    await act(() => client.refetchQueries({ queryKey: ['server'] }))
    expect(await waitFor(() => screen.getByText('El nido se reinició · cambios aplicados'))).toBeInTheDocument()
    expect(screen.queryByText('Reiniciando el nido…')).not.toBeInTheDocument()
  })
  it('observes another client’s restarting flag', async () => {
    setup({ config: pendingConfig(), respond: (r) => r.pathname === '/api/status' ? { status: 200, json: { restarting: true } } : undefined })
    expect((await waitFor(() => screen.getAllByText('Reiniciando el nido…'))).length).toBeGreaterThan(0)
  })
  it('older nest shows the muted note without controls or an error', async () => {
    setup({ respond: (r) => r.pathname === '/api/server/config' ? { status: 404, json: { detail: 'Not Found' } } : undefined })
    expect(await waitFor(() => screen.getByText('Actualiza el nido para ver esta sección.'))).toBeInTheDocument()
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('error has its words and retry recovers', async () => {
    let fail = true
    setup({ respond: (r) => r.pathname === '/api/server/config' && fail ? { status: 503, json: { detail: 'unavailable' } } : undefined })
    expect(await waitFor(() => screen.getByRole('alert'))).toHaveTextContent('No se pudo cargar la configuración.')
    fail = false
    await user.click(screen.getByRole('button', { name: 'Reintentar' }))
    await ready()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
  it('uses group skeletons until config arrives, after resolving the admin role', async () => {
    setup()
    const transport = globalThis.fetch
    let release: () => void
    const paused = new Promise<void>((resolve) => { release = resolve })
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const input = args[0]
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/api/server/config') await paused
      return transport(...args)
    }) as typeof fetch
    await waitFor(() => screen.getByRole('heading', { name: 'Rendimiento', level: 3 }))
    expect(screen.getAllByRole('status', { name: 'Cargando…' })).toHaveLength(2)
    expect(screen.queryByRole('slider')).not.toBeInTheDocument()
    await act(async () => release())
    await ready()
    expect(document.querySelector('.settings-cap .settings-skel')).not.toBeInTheDocument()
  })
})


describe('release-check switch', () => {
  it('saves live, offers undo, and names the outbound host in its tooltip', async () => {
    setup({ section: 'network' })
    await waitFor(() => screen.getByRole('switch', { name: 'Buscar actualizaciones' }))
    const row = rowIn('KROBI_UPDATE_CHECK')
    expect(within(row).getByText('Buscar actualizaciones')).toHaveAttribute('title', 'Revisa en GitHub una vez al día si hay una versión nueva de Flipspin.')
    const toggle = within(row).getByRole('switch', { name: 'Buscar actualizaciones' })
    expect(toggle).toBeChecked()
    await user.click(toggle)
    await waitFor(() => screen.getByText('Guardado'))
    expect(writes().at(-1).body).toEqual({ changes: { KROBI_UPDATE_CHECK: false } })
    expect(toggle).not.toBeChecked()
    expect(row.querySelector('.settings-restartmark')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Deshacer' }))
    await waitFor(() => expect(toggle).toBeChecked())
    expect(writes().at(-1).body).toEqual({ changes: { KROBI_UPDATE_CHECK: true } })
  })
  it('keeps an environment value locked with its source', async () => {
    const config = structuredClone(fixture) as ServerConfig
    const row = rows(config).find(r => r.key === 'KROBI_UPDATE_CHECK')!
    row.value = false; row.source = 'env'; row.editable = false
    setup({ config, section: 'network' })
    await waitFor(() => expect(rowIn('KROBI_UPDATE_CHECK')).not.toBeNull())
    expect(within(rowIn('KROBI_UPDATE_CHECK')).queryByRole('switch')).not.toBeInTheDocument()
    expect(rowIn('KROBI_UPDATE_CHECK')).toHaveTextContent('no')
    expect(rowIn('KROBI_UPDATE_CHECK')).toHaveTextContent('del nido')
    expect(writes()).toHaveLength(0)
  })
})
