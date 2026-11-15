import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { analysisDisplay } from './display'
import { AnalysisValue } from './AnalysisValue'
import { AnalysisFields } from './AnalysisFields'
import TrackTagsModal from '../albums/TrackTagsModal'
import { installFakeSettings, type FakeSettings, type RecordedRequest, type ResponseSpec } from '../settings/test-support'
import type { SchemaAnalysisView } from '../api/generated/schema'

const contract = JSON.parse(readFileSync(resolve(__dirname, '../../../contracts/analysis.json'), 'utf8'))

describe('the renderer display rule consumes every precedence contract case', () => {
  for (const item of contract.cases) it(item.name, () => {
    for (const field of ['key', 'bpm'] as const) {
      const effective = item.out[field]
      const track = { [field]: effective.value, [`${field}Estimated`]: effective.estimated, [`${field}Fixed`]: effective.source === 'fixed' }
      const cell = analysisDisplay(track, field)
      expect(cell).toMatchObject({ value: effective.value, muted: effective.value !== null && effective.estimated, pencil: effective.value !== null && effective.source === 'fixed', missing: effective.value === null })
      const sheet = analysisDisplay(track, field, true)
      expect(sheet.pencil).toBe(effective.value !== null && effective.source === 'fixed')
      const view = render(<AnalysisValue track={track} field={field} />)
      expect(view.container.querySelector('.analysis-value--estimated') !== null).toBe(effective.value !== null && effective.estimated)
      expect(view.container.querySelector('[data-kind="unanalysed"]') !== null).toBe(effective.value === null)
      expect(view.container.querySelector('.analysis-pencil') !== null).toBe(effective.value !== null && effective.source === 'fixed')
      view.unmount()
    }
  })
  it('speaks estimates and failed reasons and marks corrections everywhere', () => {
    const { rerender } = render(<AnalysisValue track={{ key: '5A', keyEstimated: true }} field="key" sheet />)
    expect(screen.getByLabelText('Estimación de Flipspin')).toHaveTextContent('≈ 5A · Do menor')
    expect(screen.getByText(', estimado')).toHaveClass('k-sr-only')
    rerender(<AnalysisValue track={{ key: '2A', keyFixed: true }} field="key" sheet />)
    expect(screen.getByRole('img', { name: 'Corregido a mano' })).toHaveClass('analysis-pencil')
    rerender(<AnalysisValue track={{ analysisState: 'failed', analysis: { error: 'undecodable' } }} field="bpm" />)
    expect(screen.getByRole('img', { name: 'undecodable' })).toHaveAttribute('data-kind', 'unanalysed')
  })
})

let fake: FakeSettings | undefined
afterEach(() => { fake?.restore(); fake = undefined })
const initial = (): SchemaAnalysisView => ({ key: { value: '2A', source: 'fixed', estimated: false }, bpm: { value: 132, source: 'fixed', estimated: false }, computed: { key: '5A', bpm: 66, keyEstimated: false, bpmEstimated: false }, fixed: { key: '2A', bpm: 132 }, rev: 3, state: 'analyzed', mood: null, energy: null, brightness: null, pulse: null })
function setup(respond?: (request: RecordedRequest) => ResponseSpec | undefined, member = false) {
  let row = initial()
  fake = installFakeSettings({ respond: raw => {
    const request = { ...raw, pathname: decodeURIComponent(raw.pathname) }
    const custom = respond?.(request)
    if (custom) return custom
    if (request.pathname === '/api/me') return { status: 200, json: { role: member ? 'member' : 'owner', isOwner: !member } }
    if (request.pathname === '/api/analysis/Album/song.flac') return { status: 200, json: row }
    if (request.pathname === '/api/analysis/Album/song.flac/fixed') {
      const body = request.body as { key?: string | null; bpm?: number | null }
      for (const field of ['key', 'bpm'] as const) if (field in body) {
        const value = body[field]
        row = { ...row, [field]: { value: value ?? row.computed[field], source: value == null ? 'computed' : 'fixed', estimated: false }, fixed: { ...row.fixed, [field]: value }, rev: row.rev + 1 }
      }
      return { status: 200, json: row }
    }
    return { status: 200, json: {} }
  } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return { wrap: (children: React.ReactNode) => <QueryClientProvider client={client}>{children}</QueryClientProvider>, get row() { return row } }
}

it('saves keys and decimal BPM independently with rev on FLAC and resets with null', async () => {
  const { wrap } = setup()
  render(wrap(<AnalysisFields relPath="Album/song.flac" />))
  const select = await screen.findByRole('button', { name: 'Tono' })
  await userEvent.click(select)
  expect(screen.getAllByRole('option')).toHaveLength(25)
  await userEvent.click(screen.getByRole('option', { name: '8A · La menor' }))
  await waitFor(() => expect(fake!.requests.filter(r => r.method === 'PUT')).toHaveLength(1))
  await waitFor(() => expect(select).toBeEnabled())
  const bpm = screen.getByRole('spinbutton', { name: 'BPM' })
  fireEvent.change(bpm, { target: { value: '128.5' } }); fireEvent.blur(bpm)
  await waitFor(() => expect(fake!.requests.filter(r => r.method === 'PUT')).toHaveLength(2))
  await waitFor(() => expect(bpm).toBeEnabled())
  await userEvent.click(select)
  await userEvent.click(screen.getByRole('option', { name: /Automático/ }))
  await waitFor(() => expect(select).toHaveTextContent('Automático5A'))
  expect(screen.queryByRole('button', { name: 'Usar automático · 5A' })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Usar automático · 66' }))
  await waitFor(() => expect(bpm).toHaveValue(66))
  expect(fake!.requests.filter(r => r.method === 'PUT').map(r => r.body)).toEqual([{ rev: 3, key: '8A' }, { rev: 4, bpm: 128.5 }, { rev: 5, key: null }, { rev: 6, bpm: null }])
  expect(fake!.requests.some(r => r.pathname.includes('update-tags'))).toBe(false)
})

it('reloads a 409 and displays the newer correction without overwriting it', async () => {
  let conflict = false
  const newer = initial(); newer.rev = 9; newer.key.value = '9A'; newer.fixed.key = '9A'
  const { wrap } = setup(request => {
    if (request.method === 'PUT') { conflict = true; return { status: 409, json: newer } }
    if (conflict && request.pathname === '/api/analysis/Album/song.flac') return { status: 200, json: newer }
  })
  render(wrap(<AnalysisFields relPath="Album/song.flac" />))
  const select = await screen.findByRole('button', { name: 'Tono' })
  await userEvent.click(select)
  await userEvent.click(screen.getByRole('option', { name: '8A · La menor' }))
  await waitFor(() => expect(select).toHaveTextContent('9A'))
  expect(await screen.findByRole('alert')).toHaveTextContent('El valor cambió en el nido. Se cargó la versión más reciente.')
  expect(fake!.requests.filter(r => r.method === 'PUT')).toHaveLength(1)
})

it('shows a 422 message inline and preserves the editable draft', async () => {
  const { wrap } = setup(request => request.method === 'PUT' ? { status: 422, json: { detail: 'El BPM debe estar entre 20 y 300' } } : undefined)
  render(wrap(<AnalysisFields relPath="Album/song.flac" />))
  const bpm = await screen.findByRole('spinbutton', { name: 'BPM' })
  fireEvent.change(bpm, { target: { value: '301' } }); fireEvent.blur(bpm)
  expect(await screen.findByRole('alert')).toHaveTextContent('El BPM debe estar entre 20 y 300')
  expect(bpm).toHaveValue(301)
})

it.each([false, true])('tags sheet exposes corrections on every format to owners only (member=%s)', async member => {
  const { wrap } = setup(undefined, member)
  render(wrap(<TrackTagsModal open track={{ path: '/music/Album/song.flac', relPath: 'Album/song.flac' }} onClose={() => {}} onSave={() => {}} />))
  if (member) {
    await waitFor(() => expect(fake!.requests.some(r => r.pathname === '/api/me')).toBe(true))
    expect(screen.queryByRole('button', { name: 'Tono' })).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Título' })).toHaveAttribute('readonly')
    expect(screen.queryByRole('spinbutton', { name: 'BPM' })).toBeNull()
  } else {
    expect(await screen.findByRole('button', { name: 'Tono' })).toBeEnabled()
    expect(screen.getByRole('spinbutton', { name: 'BPM' })).toBeEnabled()
    expect(screen.getByRole('textbox', { name: 'Título' })).toHaveAttribute('readonly')
  }
})
