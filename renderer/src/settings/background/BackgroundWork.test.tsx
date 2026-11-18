import { clockUser, installTestClock, waitForClock as waitFor } from '../../test/test-clock'

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import contract from '../../../../contracts/compute-placement.json'
import configFixture from '../../../../contracts/wire/server-config.json'
import i18n from '../../i18n'
import { DataProvider } from '../../data'
import { installFakeSettings, serverStatus, type FakeSettings, type RecordedRequest, type ResponseSpec } from '../test-support'
import { getMacState, refreshMac } from '../../lyrics/macEngine'
import { __resetLyricsStoreForTest } from '../../lyrics/lyricsStore'
import { SettingsPage } from '../SettingsPage'
import { summaryFixture } from './fixtures.testdata'
import { reasons, computerState } from './data'
import type { MacEngineStatus } from '../../lib/ipc'

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


let fake: FakeSettings
let client: QueryClient
const host = { palette: 'paper', setPalette: vi.fn(), palettes: [], mode: 'light' as const, setMode: vi.fn() }
afterEach(async () => { fake?.restore(); client?.clear(); __resetLyricsStoreForTest(); vi.restoreAllMocks(); await i18n.changeLanguage('es') })
async function setup({ section = 'equipos', data = summaryFixture(), respond, member = false, addons = {}, computeGate, local = false }: { local?: boolean; computeGate?: Promise<void>; section?: string; data?: ReturnType<typeof summaryFixture>; respond?: (r: RecordedRequest) => ResponseSpec | undefined; member?: boolean; addons?: Partial<MacEngineStatus> } = {}) {
  await i18n.changeLanguage('en')
  const config = structuredClone(configFixture)
  fake = installFakeSettings({ status: serverStatus({ mode: local ? 'child' : 'external' }), macEngine: { hardware: null, local: null, worker: null, workerError: null, tray: false, version: '0.14.1', sizeBytes: null, agentRunning: true, installing: null, installError: null, workerSource: '', toolsDir: '', modelsDir: '', supported: true, eligible: true, workerId: 'helper', installed: true, engineReady: true, uv: true, enabled: true, addons: { analysis: { installed: true, ready: true, sizeBytes: 80_000_000 }, stems: { installed: true, ready: true, sizeBytes: 100_000_000 }, lyrics: { installed: false, ready: false, sizeBytes: null } }, ...addons }, respond: r => {
    const override = respond?.(r)
    if (override) return override
    if (r.pathname === '/api/me') return { status: 200, json: { id: 'owner', label: 'Owner', role: member ? 'member' : 'owner', isOwner: !member, source: 'token' } }
    if (r.pathname === '/api/library/summary') return { status: 200, json: { songs: 795, albums: 180, artists: 146 } }
    if (r.pathname === '/api/compute/summary') return { status: 200, json: data }
    if (r.pathname.startsWith('/api/compute/kinds/')) { const kind = data.kinds.find(k => r.pathname.endsWith(k.kind))!; Object.assign(kind.policy, r.body); return { status: 200, json: kind.policy } }
    if (r.pathname.startsWith('/api/compute/computers/')) { const computer = data.computers.find(c => r.pathname.endsWith(c.id))!; Object.assign(computer.limits, r.body); return { status: 200, json: computer.limits } }
    if (r.pathname === '/api/compute/pause') { Object.assign(data, r.body); return { status: 200, json: r.body } }
    if (r.pathname === '/api/server/config') return { status: 200, json: config }
    if (r.pathname === '/api/lyrics/jobs') return { status: 200, json: { autoFetch: false, withLyrics: 0, pendingCount: 0, pending: [], queued: 0, engine: { mode: 'agent', helpers: [] } } }
    if (r.pathname === '/api/analysis/summary') return { status: 200, json: { total: 795, analyzed: 783, outdated: 0, queued: 12, waiting: 12, failed: 0, engineVersion: 1, helper: { online: true, name: 'Helper computer', working: false }, estimated: { songs: 505, keys: 277, bpms: 348 }, run: null } }
    if (r.pathname === '/api/analysis/runs/preview') return { status: 200, json: { waiting: 12, outdated: 0, failed: 0, correctionsKept: 12, confirmationsKept: 4, size: r.url.includes('mode=outdated') ? 12 : 795, skipped: [], estimateSeconds: r.url.includes('mode=outdated') ? 15 : 960 } }
    if (r.pathname === '/api/config/analysis-tags') return { status: 200, json: { write_analysis_tags: true } }
    return undefined
  } })
  if (computeGate) {
    const fetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input)
      if (new URL(url).pathname === '/api/compute/summary') await computeGate
      return fetch(input, init)
    }) as typeof globalThis.fetch
  }
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<DataProvider queryClient={client}><SettingsPage initialSection={section} surface="app" host={host} /></DataProvider>)
  await waitFor(() => screen.getByRole('heading', { name: member ? 'Overview' : section === 'complementos' ? 'Engines' : section === 'analisis' ? 'Analysis' : section === 'resumen' ? 'Overview' : 'Helpers', level: 2 }))
  if (!member && section === 'equipos') await waitFor(() => expect(screen.queryByRole('region', { name: 'Where work runs' }) || screen.queryByRole('button', { name: 'Retry' })).toBeTruthy())
  return data
}
const writes = () => fake.requests.filter(r => r.method === 'PUT' || r.method === 'POST')

describe('Helpers', () => {
  it('shows mono versions on every row including the nest and in the sheet', async () => {
    await setup()
    const computers = screen.getByRole('region', { name: 'Computers' })
    expect(within(computers).getAllByText('0.15.6')).toHaveLength(2)
    for (const version of within(computers).getAllByText('0.15.6')) expect(version).toHaveClass('z-mono')
    expect(within(computers).queryByRole('button', { name: 'Update Flipspin' })).not.toBeInTheDocument()
    await user.click(within(computers).getByRole('button', { name: /The nest/ }))
    const sheet = screen.getByRole('dialog', { name: 'The nest' })
    expect(within(sheet).getByText('0.15.6')).toBeVisible()
    expect(within(sheet).queryByText('Hours')).not.toBeInTheDocument()
    expect(within(sheet).queryByText('Any time')).not.toBeInTheDocument()
  })
  it('offers the existing release flow for an update while keeping its ready state and controls', async () => {
    const data = summaryFixture()
    Object.assign(data.computers[1], { version: '0.14.2', versionState: 'update', state: 'idle' })
    await setup({ data })
    const row = screen.getByRole('button', { name: 'Helper computer · Ready' }).closest('.bw-row')!
    expect(within(row as HTMLElement).getByText('0.14.2')).toBeVisible()
    expect(within(row as HTMLElement).getByRole('button', { name: 'Pause' })).toBeEnabled()
    const external = vi.spyOn(window, 'open').mockReturnValue(null)
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'Update Flipspin' }))
    expect(external).toHaveBeenCalledWith('https://github.com/flipspin/flipspin/releases/latest', '_blank', 'noopener,noreferrer')
  })
  it('shows a danger word and minimum tooltip even if the old helper is paused', async () => {
    const data = summaryFixture()
    Object.assign(data.computers[1], { version: '0.9.9', versionState: 'too-old', state: 'outdated' })
    data.computers[1].limits.paused = true
    await setup({ data })
    const word = screen.getByText('Too old for this nest')
    expect(word).toHaveAttribute('title', 'Needs 0.10.0 or newer · not taking work')
    expect(word).toHaveClass('settings-word--bad')
    expect(word.querySelector('.settings-dotw--bad')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update Flipspin' })).toBeVisible()
  })
  it.each(['current', 'update', 'too-old'] as const)('adds an owner Overview to-do only for too-old (%s)', async versionState => {
    const data = summaryFixture()
    Object.assign(data.computers[1], { version: versionState === 'too-old' ? '0.9.9' : versionState === 'update' ? '0.14.2' : '0.15.5', versionState, state: versionState === 'too-old' ? 'outdated' : 'idle' })
    await setup({ data, section: 'resumen' })
    const title = 'Helper computer is too old for this nest'
    if (versionState === 'too-old') {
      expect(await waitFor(() => screen.getByText(title))).toBeVisible()
      expect(screen.getByText('Needs 0.10.0 or newer · not taking work')).toBeVisible()
    } else {
      await waitFor(() => expect(client.getQueryData(['compute', 'summary'])).toBeDefined())
      expect(screen.queryByText(title)).not.toBeInTheDocument()
    }
  })

  it('shows a helper schedule while omitting the nest hours fact', async () => {
    const data = summaryFixture()
    data.computers[1].limits.window = { days: [0], startMinute: 60, endMinute: 420 }
    await setup({ data })
    expect(screen.getByText('01:00–07:00')).toBeVisible()
    expect(screen.getByRole('button', { name: /The nest/ }).closest('.bw-row')!.children[2]).toBeEmptyDOMElement()
  })

  it('shows the two tables, actual waiting badge, measured speeds and memory gate', async () => {
    await setup()
    expect(await waitFor(() => screen.getByRole('region', { name: 'Where work runs' }))).toBeVisible()
    expect(screen.getByRole('region', { name: 'Computers' })).toBeVisible()
    expect(within(screen.getByRole('navigation')).getByRole('button', { name: /Helpers/ })).toHaveTextContent('49')
    expect(within(screen.getByRole('region', { name: 'Where work runs' })).getByText('Lyrics sync')).toBeVisible()
    expect(screen.getByText('Analysis · 1.2 s/min')).toBeVisible()
    expect(screen.getAllByText('Waiting for Helper computer')[0]).toBeVisible()
    const placement = screen.getByRole('combobox', { name: 'Lyrics sync may run on' })
    expect(within(placement).getByRole('option', { name: 'Anywhere · needs 8 GB' })).toBeDisabled()
    expect(screen.queryByText('Engines on this computer')).not.toBeInTheDocument()
    expect(within(screen.getByRole('main')).queryByText('Ties')).not.toBeInTheDocument()
    expect(screen.queryByRole('switch', { name: 'Separate in background' })).not.toBeInTheDocument()
    const panels = screen.getAllByRole('region').filter(panel => ['Computers', 'Where work runs'].includes(panel.getAttribute('aria-label') ?? ''))
    expect(panels.map(panel => panel.getAttribute('aria-label'))).toEqual(['Computers', 'Where work runs'])
  })
  it('saves placement, kind pause, computer pace, computer pause and all pause through typed routes', async () => {
    await setup()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Analysis may run on' }), 'helpers')
    await waitFor(() => expect(writes().at(-1)?.body).toEqual({ placement: 'helpers' }))
    const work = screen.getByRole('region', { name: 'Where work runs' })
    await user.click(within(work).getAllByRole('button', { name: 'Pause' })[0])
    await waitFor(() => screen.getByRole('button', { name: 'Resume' }))
    expect(writes().at(-1)?.body).toEqual({ paused: true })
    const computers = screen.getByRole('region', { name: 'Computers' })
    await user.click(within(computers).getByRole('group', { name: 'Helper computer pace' }).querySelectorAll('button')[1])
    await waitFor(() => expect(writes().at(-1)?.body).toMatchObject({ pace: 'gentle' }))
    await user.click(within(computers).getAllByRole('button', { name: 'Pause' })[1])
    await waitFor(() => expect(writes().at(-1)?.body).toMatchObject({ paused: true }))
    await user.click(screen.getByRole('button', { name: 'Pause all' }))
    await waitFor(() => screen.getByRole('button', { name: 'Resume all' }))
    expect(writes().at(-1)?.pathname).toBe('/api/compute/pause')
  })
  it('opens a helper sheet, saves hours and charging, then restores focus on Escape', async () => {
    await setup()
    const opener = screen.getByRole('button', { name: /Helper computer · Asleep/ })
    await user.click(opener)
    const sheet = screen.getByRole('dialog', { name: 'Helper computer' })
    expect(within(sheet).getByText(/Apple Silicon · macos · 16 GB/)).toBeVisible()
    await user.click(within(sheet).getByRole('switch', { name: 'Only when charging' }))
    await waitFor(() => expect(writes().at(-1)?.body).toMatchObject({ onlyCharging: true }))
    await user.click(within(sheet).getByRole('button', { name: 'Change' }))
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']) expect(within(sheet).getByRole('checkbox', { name: day })).toBeVisible()
    await act(() => i18n.changeLanguage('es'))
    for (const day of ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']) expect(within(sheet).getByRole('checkbox', { name: day })).toBeVisible()
    await act(() => i18n.changeLanguage('en'))
    fireEvent.change(within(sheet).getByLabelText('From'), { target: { value: '18:30' } })
    fireEvent.change(within(sheet).getByLabelText('Until'), { target: { value: '23:00' } })
    await user.click(within(sheet).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(writes().at(-1)?.body).toMatchObject({ window: { startMinute: 1110, endMinute: 1380 } }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(opener).toHaveFocus()
  })
  it('shows nest caps and thermal readings without a schedule', async () => {
    await setup()
    const nestRow = screen.getByRole('button', { name: /The nest/ }).closest('.bw-row')!
    expect(nestRow.children[2]).toBeEmptyDOMElement()
    expect(within(screen.getByRole('button', { name: /Helper computer · Asleep/ }).closest('.bw-row')! as HTMLElement).getByText('Any time')).toBeVisible()
    await user.click(screen.getByRole('button', { name: /The nest/ }))
    const sheet = screen.getByRole('dialog', { name: 'The nest' })
    expect(within(sheet).getByText(/85 °C · resumes at 75 °C · now 64 °C/)).toBeVisible()
    await user.selectOptions(within(sheet).getByRole('combobox', { name: 'CPU limit' }), '25')
    await waitFor(() => expect(writes().at(-1)?.body).toMatchObject({ cpuPercent: 25 }))
    expect(within(sheet).queryByRole('switch', { name: 'Only when charging' })).not.toBeInTheDocument()
    expect(within(sheet).queryByText('Library passes')).not.toBeInTheDocument()
    expect(within(sheet).queryByText('Hours')).not.toBeInTheDocument()
    expect(within(sheet).queryByRole('button', { name: 'Change' })).not.toBeInTheDocument()
  })
  it('shows retry on a summary failure and no owner requests for a member', async () => {
    let failed = true
    await setup({ respond: r => r.pathname === '/api/compute/summary' && failed ? { status: 500, json: {} } : undefined })
    const retry = (await waitFor(() => screen.getAllByRole('button', { name: 'Retry' })))[0]
    failed = false
    await user.click(retry)
    await waitFor(() => screen.getByRole('region', { name: 'Where work runs' }))
  })
  it('keeps the page and owner settings inaccessible to members', async () => {
    await setup({ member: true })
    expect(fake.requests.some(r => r.pathname === '/api/compute/summary')).toBe(false)
    expect(screen.queryByRole('button', { name: /Helpers/ })).not.toBeInTheDocument()
  })
  it('keeps all setup steps together when no helper has enrolled', async () => {
    const data = summaryFixture(); data.computers = data.computers.slice(0, 1); data.kinds[0].reason = 'no-helper'
    await setup({ data })
    expect(screen.getByText('Needs a helper')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Add a computer' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('Install Flipspin on that computer')
    expect(screen.getByRole('dialog').querySelectorAll('li')).toHaveLength(3)
  })
  it.each(['thermal', 'paused', 'hours', 'battery', 'memory', 'no-engine', 'no-cgroup'] as const)('renders the %s waiting state from the summary', async reason => {
    const data = summaryFixture(); data.kinds[2].reason = reason
    await setup({ data })
    expect(screen.getByText(i18n.t(reasons[reason]))).toBeVisible()
  })
})

describe('Analysis page', () => {
  it('keeps the overview and undo beside the run controls and auto switch', async () => {
    let written = true
    await setup({ section: 'analisis', respond: r => {
      if (r.pathname !== '/api/config/analysis-tags') return undefined
      if (r.method === 'PUT') written = (r.body as { write_analysis_tags: boolean }).write_analysis_tags
      return { status: 200, json: { write_analysis_tags: written } }
    } })
    const page = await waitFor(() => screen.getByRole('region', { name: 'Analysis' }))
    expect(await waitFor(() => within(page).getByText('Analyzed'))).toBeVisible()
    expect(page.querySelectorAll('.z-meter')).toHaveLength(1)
    expect(within(page).getByRole('button', { name: 'Review' })).toBeVisible()
    expect(within(page).getByRole('button', { name: 'Details' })).toBeVisible()
    const tags = within(page).getByRole('switch', { name: 'Save BPM and key in the files' })
    expect(within(page).getAllByRole('switch')).toHaveLength(2)
    await user.click(tags)
    await waitFor(() => expect(written).toBe(false))
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(written).toBe(true))
    await user.click(within(page).getByRole('switch', { name: 'Analyze new songs automatically' }))
    await waitFor(() => expect(writes().some(r => r.pathname === '/api/server/config')).toBe(true))
    await user.click(await waitFor(() => within(page).getByRole('radio', { name: /Whole library · 795/ })))
    await user.click(within(page).getByRole('button', { name: 'Analyze 795 songs' }))
    await waitFor(() => expect(writes().some(r => r.pathname === '/api/analysis/runs')).toBe(true))
    expect(writes().find(r => r.pathname === '/api/analysis/runs')?.body).toMatchObject({ mode: 'all', scope: 'library' })
  })
})

describe('Analysis run controls', () => {
  async function open(respond?: (r: RecordedRequest) => ResponseSpec | undefined) {
    await setup({ section: 'analisis', respond })
    return waitFor(() => screen.getByRole('region', { name: 'Analysis' }))
  }
  it('defaults to new/outdated, previews both counts and sends one real run request', async () => {
    const sheet = await open()
    expect(await waitFor(() => within(sheet).getByRole('radio', { name: /New or outdated · 12/ }))).toBeChecked()
    expect(within(sheet).getByRole('radio', { name: /Whole library · 795/ })).not.toBeChecked()
    expect(within(sheet).getByRole('radio', { name: /Whole library/ }).closest('label')).toHaveAttribute('title', expect.stringContaining('Keeps 12 corrections and 4 confirmations'))
    await user.click(within(sheet).getByRole('button', { name: 'Analyze 12 songs' }))
    await waitFor(() => expect(writes().some(r => r.pathname === '/api/analysis/runs')).toBe(true))
    expect(writes().find(r => r.pathname === '/api/analysis/runs')?.body).toMatchObject({ mode: 'outdated', scope: 'library' })
  })
  it('shows Waiting for helper on a refused whole-library run', async () => {
    const sheet = await open(r => r.pathname === '/api/analysis/runs' ? { status: 409, json: { detail: { code: 'no-helper' } } } : undefined)
    await user.click(await waitFor(() => within(sheet).getByRole('radio', { name: /Whole library · 795/ })))
    await user.click(within(sheet).getByRole('button', { name: 'Analyze 795 songs' }))
    expect(await waitFor(() => within(sheet).getByText('Waiting for Helper computer'))).toBeVisible()
  })
  it('shows progress and stops the ledger job, keeping completed results', async () => {
    const sheet = await open(r => r.pathname === '/api/analysis/summary' ? { status: 200, json: { total: 795, analyzed: 312, queued: 483, failed: 0, estimated: { songs: 0, keys: 0, bpms: 0 }, run: { id: 'run', jobId: 'job', size: 795, done: 312, failed: 0, waiting: null, etaSeconds: 600 } } } : undefined)
    expect(await waitFor(() => within(sheet).getByText(/312 of 795/))).toBeVisible()
    await user.click(within(sheet).getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(writes().some(r => r.pathname === '/api/jobs/job/cancel')).toBe(true))
  })
  it('omits the removed switches and hides outdated status when current', async () => {
    const sheet = await open()
    expect(within(sheet).queryByRole('switch', { name: 'Analyze the whole library automatically' })).not.toBeInTheDocument()
    expect(within(sheet).queryByRole('switch', { name: 'Re-analyze after an engine update' })).not.toBeInTheDocument()
    expect(within(sheet).queryByText('Outdated')).not.toBeInTheDocument()
  })
  it('shows outdated status and count beside the run button', async () => {
    const sheet = await open(r => r.pathname === '/api/analysis/summary' ? { status: 200, json: { total: 10, analyzed: 8, outdated: 2, queued: 0, failed: 0, estimated: { songs: 0, keys: 0, bpms: 0 }, run: null } } : undefined)
    const status = await waitFor(() => within(sheet).getByTitle('2 songs analysed by an older engine'))
    expect(status).toHaveTextContent('Analysis · Outdated')
    expect(status).toHaveAttribute('title', '2 songs analysed by an older engine')
    expect(status.querySelector('i')).toBeInTheDocument()
    expect(status.parentElement).toContainElement(within(sheet).getByRole('button', { name: 'Analyze 12 songs' }))
  })
  it('writes auto and tags settings at the existing routes', async () => {
    const sheet = await open()
    const auto = await waitFor(() => within(sheet).getByRole('switch', { name: 'Analyze new songs automatically' }))
    await waitFor(() => expect(auto).toBeEnabled())
    await user.click(auto)
    await waitFor(() => expect(writes().some(r => r.pathname === '/api/server/config')).toBe(true))
    expect(writes().find(r => r.pathname === '/api/server/config')?.body).toEqual({ changes: { KROBI_ANALYSIS_AUTO: false } })
    await user.click(within(sheet).getByRole('switch', { name: 'Save BPM and key in the files' }))
    await waitFor(() => expect(writes().some(r => r.pathname === '/api/config/analysis-tags')).toBe(true))
    expect(writes().find(r => r.pathname === '/api/config/analysis-tags')?.body).toEqual({ write_analysis_tags: false })
  })
})

describe('Add-on cards and licence', () => {
  it('waits for compute facts before accepting and persisting install-all', async () => {
    let release!: () => void
    const computeGate = new Promise<void>(resolve => { release = resolve })
    await setup({ section: 'complementos', computeGate })
    const toggle = screen.getByRole('switch', { name: 'Install everything this computer can run' })
    // Device readiness alone must not enable a choice whose policy cannot be saved.
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Help the nest' })).toBeEnabled())
    expect(client.getQueryState(['compute', 'summary'])?.status).toBe('pending')
    expect(toggle).toBeDisabled()
    await user.click(toggle)
    expect(toggle).not.toBeChecked()
    expect(writes()).toHaveLength(0)
    expect(fake.invokedWith('lyrics:engine-install')).toHaveLength(0)
    await act(async () => { release() })
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)
    await waitFor(() => {
      expect(toggle).toBeChecked()
      expect(writes().some(r => r.pathname === '/api/compute/computers/helper' && (r.body as { installEverything?: boolean }).installEverything === true)).toBe(true)
    })
  })
  it('saves Help the nest through the native bridge and refreshes its switch', async () => {
    await setup({ section: 'complementos' })
    const toggle = screen.getByRole('switch', { name: 'Help the nest' })
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toBeChecked()
    await user.click(toggle)
    await waitFor(() => expect(toggle).not.toBeChecked())
    expect(fake.invokedWith('lyrics:worker-set')).toEqual([{ enabled: false }])
  })
  it('uses the desktop helper for a local nest, including its switch and per-device limits', async () => {
    await setup({ section: 'complementos', local: true })
    const toggle = screen.getByRole('switch', { name: 'Help the nest' })
    await waitFor(() => expect(toggle).toBeEnabled())
    expect(toggle).toBeChecked()
    await user.click(toggle)
    await waitFor(() => expect(fake.invokedWith('lyrics:worker-set')).toEqual([{ enabled: false }]))
    const lyrics = screen.getByRole('region', { name: 'Lyrics' })
    await user.click(within(lyrics).getByRole('button', { name: 'Install' }))
    const dialog = screen.getByRole('dialog', { name: 'Install Lyrics sync?' })
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name: 'Install Lyrics sync' }))
    await waitFor(() => expect(fake.invokedWith('lyrics:engine-install')).toEqual([{ target: 'lyrics' }]))
    await user.click(within(screen.getByRole('region', { name: 'Analysis' })).getByRole('checkbox', { name: 'Use Analysis' }))
    await waitFor(() => expect(writes().at(-1)?.pathname).toBe('/api/compute/computers/helper'))
    expect(writes().some(r => r.pathname.startsWith('/api/lyrics/engine/'))).toBe(false)
    expect(writes().some(r => r.pathname === '/api/compute/computers/nest')).toBe(false)
  })
  it('requires the non-commercial acknowledgement before installing Lyrics sync', async () => {
    await setup({ section: 'complementos' })
    const lyrics = screen.getByRole('region', { name: 'Lyrics' })
    await waitFor(() => expect(within(lyrics as HTMLElement).getByRole('button', { name: 'Install' })).toBeEnabled())
    await user.click(within(lyrics as HTMLElement).getByRole('button', { name: 'Install' }))
    const dialog = screen.getByRole('dialog', { name: 'Install Lyrics sync?' })
    expect(dialog).toHaveTextContent('CC BY-NC 4.0 · non-commercial')
    const install = within(dialog).getByRole('button', { name: 'Install Lyrics sync' })
    expect(install).toBeDisabled()
    expect(fake.invocations.some(c => c.channel === 'lyrics:engine-install')).toBe(false)
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(install)
    await waitFor(() => expect(fake.invocations.some(c => c.channel === 'lyrics:engine-install' && JSON.stringify(c.request) === JSON.stringify({ target: 'lyrics' }))).toBe(true))
  })
  it('installs everything except Lyrics sync and persists per-feature Use', async () => {
    await setup({ section: 'complementos' })
    const installAll = screen.getByRole('switch', { name: 'Install everything this computer can run' })
    await waitFor(() => expect(installAll).toBeEnabled())
    await user.click(installAll)
    await waitFor(() => expect(writes().some(r => r.pathname === '/api/compute/computers/helper')).toBe(true))
    expect(fake.invocations.filter(c => c.channel === 'lyrics:engine-install').every(c => JSON.stringify(c.request) !== JSON.stringify({ target: 'lyrics' }))).toBe(true)
    const analysis = screen.getByRole('region', { name: 'Analysis' })
    await user.click(within(analysis as HTMLElement).getByRole('checkbox', { name: 'Use Analysis' }))
    await waitFor(() => expect(writes().at(-1)?.body).toMatchObject({ use: { analysis: false } }))
    expect(screen.queryByText('Analyzed')).not.toBeInTheDocument()
  })
  it('waits for each installed target before starting the next batch target', async () => {
    await setup({ section: 'complementos', addons: { installed: false, engineReady: false, addons: {
      lyrics: { installed: false, ready: false, sizeBytes: null },
      stems: { installed: false, ready: false, sizeBytes: null },
      analysis: { installed: false, ready: false, sizeBytes: null },
    } } })
    const toggle = screen.getByRole('switch', { name: 'Install everything this computer can run' })
    await waitFor(() => expect(toggle).toBeEnabled())
    await user.click(toggle)
    await waitFor(() => expect(fake.invokedWith('lyrics:engine-install')).toEqual([{ target: 'engine' }]))
    expect(toggle).toBeDisabled()
    const status = getMacState().status!
    await act(async () => { status.installed = true; status.engineReady = true; await refreshMac() })
    await waitFor(() => expect(fake.invokedWith('lyrics:engine-install')).toEqual([{ target: 'engine' }, { target: 'analysis' }]))
    await act(async () => { Object.assign(status.addons!.analysis, { installed: true, ready: true }); await refreshMac() })
    await waitFor(() => expect(fake.invokedWith('lyrics:engine-install')).toEqual([{ target: 'engine' }, { target: 'analysis' }, { target: 'stems' }]))
    await act(async () => { Object.assign(status.addons!.stems, { installed: true, ready: true }); await refreshMac() })
    await waitFor(() => expect(toggle).toBeEnabled())
    await waitFor(() => expect(toggle).toBeChecked())
  })
  it('installs only Analysis on a computer below the shared engine memory gate', async () => {
    const data = summaryFixture()
    data.computers[1].memoryBytes = 4 * 2 ** 30
    data.computers[1].jobs = ['analysis']
    await setup({ section: 'complementos', data, addons: { installed: false, engineReady: false,
      hardware: { name: 'Computer', memoryBytes: 4 * 2 ** 30, jobs: ['analysis'], chip: null, gpu: null, accel: 'cpu' },
      addons: { lyrics: { installed: false, ready: false, sizeBytes: null }, stems: { installed: false, ready: false, sizeBytes: null }, analysis: { installed: false, ready: false, sizeBytes: null } },
    } })
    const analysis = screen.getByRole('region', { name: 'Analysis' })
    await waitFor(() => expect(within(analysis).getByRole('button', { name: 'Install' })).toBeEnabled())
    const stems = screen.getByRole('region', { name: 'Stems' })
    expect(within(stems).getByRole('button', { name: 'Install' })).toBeDisabled()
    const installAll = screen.getByRole('switch', { name: 'Install everything this computer can run' })
    await waitFor(() => expect(installAll).toBeEnabled())
    await user.click(installAll)
    await waitFor(() => expect(fake.invokedWith('lyrics:engine-install')).toEqual([{ target: 'analysis' }]))
  })
  it('shows installation errors with Retry and progress from the machine', async () => {
    await setup({ section: 'complementos', addons: { addons: { stems: { installed: false, ready: false, sizeBytes: null }, lyrics: { installed: false, ready: false, sizeBytes: null, error: 'disk full' }, analysis: { installed: false, ready: false, sizeBytes: null } }, installing: { target: 'analysis', phase: 'models', percent: 62 } } })
    expect(screen.getByTitle('disk full')).toBeVisible()
    expect(within(screen.getByRole('region', { name: 'Lyrics' })).getByRole('button', { name: 'Repair' })).toBeDisabled()
    expect(screen.getByRole('progressbar', { name: 'Installing Analysis' })).toHaveAttribute('aria-valuenow', '62')
  })
})

it.each(contract.cases.filter(c => c.reason))('maps the shared wait reason: $name', c => {
  if (c.reason === 'helpers-only') expect(reasons['no-helper']).toBeTruthy()
  else expect(reasons[c.reason!]).toBeTruthy()
})
it('computer states keep pause and thermal conditions ahead of presence', () => {
  const c = summaryFixture().computers[1]
  expect(i18n.t(computerState({ ...c, pausedReason: 'thermal' }))).toBe('Enfriándose')
  expect(i18n.t(computerState({ ...c, limits: { ...c.limits, paused: true } }))).toBe('En pausa')
})


describe('Lyrics engine state in the nest', () => {
  it.each([
    [{ mode: 'local', hint: 'ready', installed: true, ready: true }, 'ready'],
    [{ mode: 'local', hint: 'not-installed', installed: false }, 'not installed'],
    [{ mode: 'local', hint: 'install-failed', installError: 'failed' }, 'failing'],
    [{ mode: 'local', hint: 'installing', installing: { target: 'lyrics', percent: 62 } }, 'installing'],
    [{ mode: 'local', hint: 'models-missing', installed: true }, 'models missing'],
    [{ mode: 'local', running: { done: 1, total: 2 } }, 'working'],
    [{ mode: 'agent', helpers: [{ state: 'offline' }] }, 'Offline'],
    [{ mode: 'agent', helpers: [{ state: 'outdated' }] }, 'Outdated'],
    [{ mode: 'agent', helpers: [{ state: 'idle' }] }, 'Available'],
  ])('uses the reported engine state %j', async (engine, word) => {
    await setup({ section: 'complementos', respond: r => r.pathname === '/api/lyrics/jobs'
      ? { status: 200, json: { autoFetch: false, withLyrics: 0, pendingCount: 0, engine } } : undefined })
    const card = screen.getByRole('region', { name: 'Lyrics' })
    const row = (await waitFor(() => within(card).getByText('In the nest'))).closest('.ks-row')! as HTMLElement
    await waitFor(() => expect(within(row).getByText(word)).toBeVisible())
    expect(within(row).queryByText('Running')).not.toBeInTheDocument()
  })
  it.each(['all', 'lyrics'])('shows a paused engine when %s work is off', async scope => {
    const data = summaryFixture()
    if (scope === 'all') data.paused = true
    else data.kinds[0].policy.paused = true
    await setup({ section: 'complementos', data })
    const card = screen.getByRole('region', { name: 'Lyrics' })
    const row = (await waitFor(() => within(card).getByText('In the nest'))).closest('.ks-row')! as HTMLElement
    await waitFor(() => expect(within(row).getByText('Paused')).toBeVisible())
    expect(within(row).queryByText('Running')).not.toBeInTheDocument()
  })
})
