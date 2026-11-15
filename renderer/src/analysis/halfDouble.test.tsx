import { installTestClock, clockUser, waitForClock as waitFor } from '../test/test-clock'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SchemaAnalysisView, SchemaEstimateRow } from '../api/generated/schema'
import { installFakeSettings, type FakeSettings } from '../settings/test-support'
import TrackTagsModal from '../albums/TrackTagsModal'
import { InformationAnalysis } from './InformationAnalysis'
import { ReviewEstimates } from './ReviewEstimates'

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


let fake: FakeSettings | undefined
afterEach(() => { fake?.restore(); fake = undefined;  })
const relPath = 'Album/song.flac'
const song = 'Paper Satellites'
type Surface = 'info' | 'tags' | 'review'
function setup(surface: Surface, { bpm = 94 as number | null, source = 'computed' as 'computed' | 'fixed' | 'tag', member = false, failure = 0, bpmOnly = false } = {}) {
  let view: SchemaAnalysisView = {
    key: { value: '5A', estimated: !bpmOnly, source: 'computed' }, bpm: { value: bpm, estimated: source === 'computed' && bpm !== null, source },
    computed: { key: '5A', bpm: 94, keyEstimated: true, bpmEstimated: true }, fixed: { key: null, bpm: source === 'fixed' ? bpm : null },
    rev: 3, state: 'analyzed', mood: null, energy: null, brightness: null, pulse: null,
  }
  const row = (): SchemaEstimateRow => ({ relPath, title: song, artist: 'Ensemble', album: 'Album', key: view.key.value as string, keyEstimated: view.key.estimated, keySource: view.key.source, bpm: view.bpm.value as number | null, bpmEstimated: view.bpm.estimated, bpmSource: view.bpm.source, rev: view.rev })
  fake = installFakeSettings({ respond: request => {
    const path = decodeURIComponent(request.pathname)
    if (path.startsWith('/api/library/tags/')) return { status: 200, json: { fields: { title: song }, format: 'FLAC', writable: true, rev: 'tags-1' } }
    if (path === '/api/me') return { status: 200, json: { role: member ? 'member' : 'owner', isOwner: !member } }
    if (path === '/api/analysis/summary') return { status: 200, json: { estimated: { songs: 1, keys: 1, bpms: 1 } } }
    if (path === '/api/analysis/estimates') return { status: 200, json: { rows: [row()], after: null } }
    if (path === `/api/analysis/${relPath}/fixed` && request.method === 'PUT') {
      if (failure === 422) return { status: 422, json: { detail: [{ msg: 'BPM fuera de rango' }] } }
      if (failure === 409) {
        view = { ...view, rev: 9, bpm: { value: 100, estimated: true, source: 'computed' }, computed: { ...view.computed, bpm: 100 } }
        return { status: 409, json: view }
      }
      const body = request.body as { rev: number; bpm: number | null }
      if (body.rev !== view.rev) return { status: 409, json: view }
      view = { ...view, rev: view.rev + 1, fixed: { ...view.fixed, bpm: body.bpm }, bpm: { value: body.bpm ?? view.computed.bpm, estimated: body.bpm === null, source: body.bpm === null ? 'computed' : 'fixed' } }
      return { status: 200, json: view }
    }
    if (path === `/api/analysis/${relPath}`) return { status: 200, json: view }
    return { status: 200, json: {} }
  } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const node = surface === 'info' ? <dl><InformationAnalysis relPath={relPath} track={{}} /></dl>
    : surface === 'tags' ? <TrackTagsModal open track={{ title: song, path: `/music/${relPath}`, relPath }} onClose={() => {}} onSave={() => {}} />
      : <ReviewEstimates onPlay={() => {}} onTags={() => {}} />
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
  return { client, puts: () => fake!.requests.filter(r => r.method === 'PUT'), name: (label: string) => surface === 'review' ? `${label} · ${song}` : label }
}

describe.each<Surface>(['info', 'tags', 'review'])('%s half/double BPM', surface => {
  it.each([{ factor: '×2', label: 'Duplicar BPM a 188', result: 188, message: 'BPM duplicado a 188' }, { factor: '½', label: 'Reducir BPM a la mitad: 47', result: 47, message: 'BPM reducido a la mitad: 47' }])('previews $factor, saves one revision-aware correction and undoes to automatic', async ({ factor, label, result, message }) => {
    const { puts, name } = setup(surface)
    const button = await waitFor(() => screen.getByRole('button', { name: name(label) }))
    expect(button).toHaveAttribute('title', `${factor} → ${result}`)
    expect(puts()).toHaveLength(0)
    await user.click(button)
    expect(await waitFor(() => screen.getByText(message))).toBeInTheDocument()
    expect(puts().map(r => [decodeURIComponent(r.pathname), r.body])).toEqual([[`/api/analysis/${relPath}/fixed`, { rev: 3, bpm: result }]])
    expect(screen.getAllByRole('button', { name: 'Deshacer' })).toHaveLength(1)
    expect(screen.getByText(message).closest('ul')).toHaveAttribute('aria-live', 'polite')
    if (surface === 'tags') expect(screen.getByRole('spinbutton', { name: 'BPM' })).toHaveValue(result)
    else expect(screen.getAllByRole('img', { name: 'Corregido a mano' })).toHaveLength(1)
    vi.useFakeTimers()
    await act(() => vi.advanceTimersByTimeAsync(31_000))
    expect(screen.getByText(message)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Deshacer' }))
    expect(await waitFor(() => screen.getByRole('button', { name: name('Duplicar BPM a 188') }))).toBeEnabled()
    expect(puts().map(r => r.body)).toEqual([{ rev: 3, bpm: result }, { rev: 4, bpm: null }])
  })

  it('restores the previous manual value on Undo', async () => {
    const { puts, name } = setup(surface, { bpm: 90, source: 'fixed' })
    await user.click(await waitFor(() => screen.getByRole('button', { name: name('Duplicar BPM a 180') })))
    await waitFor(() => screen.getByText('BPM duplicado a 180'))
    await user.click(screen.getByRole('button', { name: 'Deshacer' }))
    expect(await waitFor(() => screen.getByRole('button', { name: name('Duplicar BPM a 180') }))).toBeEnabled()
    expect(puts().map(r => r.body)).toEqual([{ rev: 3, bpm: 180 }, { rev: 4, bpm: 90 }])
    expect(screen.queryByText('BPM confirmado')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Deshacer' })).toBeNull()
  })

  it('reloads a 409 and previews the new result without retrying the correction', async () => {
    const { puts, name } = setup(surface, { failure: 409 })
    await user.click(await waitFor(() => screen.getByRole('button', { name: name('Duplicar BPM a 188') })))
    const next = await waitFor(() => screen.getByRole('button', { name: name('Duplicar BPM a 200') }))
    expect(next).toHaveAttribute('title', '×2 → 200')
    expect(puts().map(r => r.body)).toEqual([{ rev: 3, bpm: 188 }])
    expect(fake!.requests.filter(r => r.method === 'GET' && decodeURIComponent(r.pathname) === `/api/analysis/${relPath}`).length).toBeGreaterThanOrEqual(surface === 'review' ? 1 : 2)
    expect(screen.queryByRole('button', { name: 'Deshacer' })).toBeNull()
  })

  it('shows a 422 inline, keeps the value and offers no Undo', async () => {
    const { puts, name } = setup(surface, { failure: 422 })
    await user.click(await waitFor(() => screen.getByRole('button', { name: name('Duplicar BPM a 188') })))
    expect(await waitFor(() => screen.getByRole('alert'))).toHaveTextContent('BPM fuera de rango')
    expect(screen.getByRole('button', { name: name('Duplicar BPM a 188') })).toBeEnabled()
    expect(screen.queryByText('BPM duplicado a 188')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Deshacer' })).toBeNull()
    expect(puts()).toHaveLength(1)
  })

  it('offers no half/double control to a member', async () => {
    const { client } = setup(surface, { member: true })
    await waitFor(() => expect(client.getQueryData(['me', 'profile'])).toEqual(expect.objectContaining({ role: 'member' })))
    expect(document.querySelector('.analysis-bpm-scale')).toBeNull()
    expect(screen.queryByRole('button', { name: /Duplicar BPM|Reducir BPM/ })).toBeNull()
  })

  it.each([{ bpm: 39, half: false, double: true }, { bpm: 151, half: true, double: false }, { bpm: 40, half: true, double: true }, { bpm: 150, half: true, double: true }])('hides results outside 20–300 at $bpm BPM', async ({ bpm, half, double }) => {
    const { client } = setup(surface, { bpm })
    await waitFor(() => expect(client.getQueryData(['me', 'profile'])).toBeTruthy())
    await waitFor(() => expect(document.querySelector('.analysis-bpm-scale')).toBeTruthy())
    const control = document.querySelector('.analysis-bpm-scale') as HTMLElement
    expect(within(control).queryByText('½') !== null).toBe(half)
    expect(within(control).queryByText('×2') !== null).toBe(double)
  })

  it('disables both buttons when BPM is missing', async () => {
    const { client, puts } = setup(surface, { bpm: null })
    await waitFor(() => expect(client.getQueryData(['me', 'profile'])).toBeTruthy())
    await waitFor(() => expect(document.querySelector('.analysis-bpm-scale')).toBeTruthy())
    const control = document.querySelector('.analysis-bpm-scale') as HTMLElement
    const buttons = within(control).getAllByRole('button')
    expect(buttons).toHaveLength(2)
    for (const button of buttons) { expect(button).toBeDisabled(); fireEvent.click(button) }
    expect(puts()).toHaveLength(0)
  })
})

it('scales a focused BPM draft with one PUT and keeps unsaved tag edits', async () => {
  const { puts } = setup('tags')
  const title = await waitFor(() => screen.getByRole('textbox', { name: 'Título' }))
  fireEvent.change(title, { target: { value: 'Keep my title' } })
  const bpm = await waitFor(() => screen.getByRole('spinbutton', { name: 'BPM' }))
  await user.click(bpm)
  fireEvent.change(bpm, { target: { value: '94.1' } })
  const half = screen.getByRole('button', { name: 'Reducir BPM a la mitad: 47.05' })
  expect(half).toHaveAttribute('title', '½ → 47.05')
  await user.click(half)
  await waitFor(() => screen.getByText('BPM reducido a la mitad: 47.05'))
  expect(puts().map(r => r.body)).toEqual([{ rev: 3, bpm: 47.05 }])
  expect(title).toHaveValue('Keep my title')
  expect(bpm).toHaveValue(47.05)
  expect(bpm).toBeValid()
})

it('removes a BPM-only estimate row, focuses the heading and restores it on Undo', async () => {
  const { name } = setup('review', { bpmOnly: true })
  await user.click(await waitFor(() => screen.getByRole('button', { name: name('Duplicar BPM a 188') })))
  await waitFor(() => expect(screen.queryByRole('table')).toBeNull())
  expect(screen.getByRole('heading', { name: 'Revisar estimados' })).toHaveFocus()
  await user.click(screen.getByRole('button', { name: 'Deshacer' }))
  expect(await waitFor(() => screen.getByRole('button', { name: name('Duplicar BPM a 188') }))).toBeEnabled()
})

it.each<Surface>(['info', 'tags'])('keeps keyboard focus in %s when doubling hides the double button', async surface => {
  setup(surface)
  const button = await waitFor(() => screen.getByRole('button', { name: 'Duplicar BPM a 188' }))
  button.focus()
  await user.keyboard('{Enter}')
  await waitFor(() => screen.getByText('BPM duplicado a 188'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Reducir BPM a la mitad: 94' })).toHaveFocus())
})

it('ships hand-written English action and toast lines', () => {
  const catalog = JSON.parse(readFileSync(resolve(__dirname, '../../locales/en/translation.json'), 'utf8'))
  expect(catalog["Double BPM to {{value}}"]).toBe('Double BPM to {{value}}')
  expect(catalog["Halve BPM to {{value}}"]).toBe('Halve BPM to {{value}}')
  expect(catalog["BPM doubled to {{value}}"]).toBe('BPM doubled to {{value}}')
  expect(catalog["BPM halved to {{value}}"]).toBe('BPM halved to {{value}}')
})
