import { installTestClock, clockUser, waitForClock as waitFor } from '../test/test-clock'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SchemaAnalysisView, SchemaEstimateRow } from '../api/generated/schema'
import { installFakeSettings, type FakeSettings } from '../settings/test-support'
import { AnalysisValue } from './AnalysisValue'
import { InformationAnalysis } from './InformationAnalysis'
import { ReviewEstimates } from './ReviewEstimates'

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


let fake: FakeSettings | undefined
afterEach(() => { fake?.restore(); fake = undefined;  })
const initial = (): SchemaAnalysisView => ({ key: { value: '5A', source: 'computed', estimated: true }, bpm: { value: 66, source: 'computed', estimated: true }, computed: { key: '5A', bpm: 66, keyEstimated: true, bpmEstimated: true }, fixed: { key: null, bpm: null }, rev: 0, state: 'analyzed', mood: null, energy: null, brightness: null, pulse: null })
function setup({ member = false, conflict = false, paged = false, keysOnly = false } = {}) {
  const views = new Map(['A/one.flac', 'A/two.flac'].map(rel => [rel, initial()]))
  if (keysOnly) for (const view of views.values()) view.bpm.estimated = false
  const row = (relPath: string, title: string): SchemaEstimateRow => {
    const view = views.get(relPath)!
    return { relPath, title, artist: 'Ensemble', album: 'Signal', key: String(view.key.value), keySource: view.key.source, keyEstimated: view.key.estimated, bpm: Number(view.bpm.value), bpmSource: view.bpm.source, bpmEstimated: view.bpm.estimated, rev: view.rev }
  }
  let conflicted = false
  fake = installFakeSettings({ respond: request => {
    const path = decodeURIComponent(request.pathname)
    if (path === '/api/me') return { status: 200, json: { role: member ? 'member' : 'owner', isOwner: !member } }
    if (path === '/api/analysis/summary') return { status: 200, json: { estimated: { songs: 2, keys: 2, bpms: keysOnly ? 0 : 2 }, total: 2, analyzed: 2, queued: 0, failed: 0, engineVersion: 1, helper: { online: false, name: null, working: false } } }
    if (path === '/api/analysis/estimates') {
      const after = new URLSearchParams(request.search).get('after')
      return { status: 200, json: { rows: paged ? after ? [row('A/two.flac', 'Second Song')] : [row('A/one.flac', 'Paper Satellites')] : [row('A/one.flac', 'Paper Satellites'), row('A/two.flac', 'Second Song')], after: paged && !after ? 'A/one.flac' : null } }
    }
    const rel = path.replace('/api/analysis/', '').replace(/\/fixed$/, '')
    const view = views.get(rel)
    if (view && request.method === 'PUT') {
      if (conflict && !conflicted) {
        conflicted = true; view.rev = 9; view.computed.key = '9B'; view.key.value = '9B'
        return { status: 409, json: view }
      }
      const body = request.body as { rev: number; key?: string | null; bpm?: number | null }
      if (body.rev !== view.rev) return { status: 409, json: view }
      for (const field of ['key', 'bpm'] as const) if (field in body) {
        const value = body[field]!
        view[field] = { value: value ?? view.computed[field], source: value == null ? 'computed' : 'fixed', estimated: value == null }
        if (field === 'key') view.fixed.key = value as string | null
        else view.fixed.bpm = value as number | null
      }
      view.rev += 1
      return { status: 200, json: view }
    }
    if (view) return { status: 200, json: view }
    return { status: 200, json: {} }
  } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return { client, wrap: (ui: React.ReactNode) => <QueryClientProvider client={client}>{ui}</QueryClientProvider> }
}

it.each(['computed', 'tag', 'fixed'] as const)('shows the %s source in a focusable tooltip', source => {
  const label = { computed: 'Cálculo de Flipspin', tag: 'Etiqueta del archivo', fixed: 'Corregido a mano' }[source]
  const { container } = render(<AnalysisValue track={{ key: '5A', keySource: source }} field="key" />)
  const mark = screen.getByRole('img', { name: label })
  expect(mark.closest('[tabindex]')).toHaveAttribute('aria-label', label)
  expect(mark.closest('[tabindex]')).toHaveAttribute('tabindex', '0')
  expect(mark).not.toHaveAttribute('tabindex')
  expect(mark.querySelector('svg')).toHaveAttribute('width', '14')
  expect(container.querySelector('button')).toBeNull()
})

it('marks only the estimate value for the amber dotted underline and speaks it once', () => {
  const { container } = render(<AnalysisValue track={{ key: '5A', keyEstimated: true, keySource: 'computed' }} field="key" />)
  const estimate = container.querySelector('.analysis-value--estimated')!
  expect(estimate).toHaveClass('analysis-value--estimated')
  expect(estimate.querySelector('.analysis-value__number')).toHaveTextContent('5A')
  expect(screen.getByText(', estimado')).toHaveClass('k-sr-only')
  expect(container.querySelector('.analysis-source')).toBeNull()
})

it('confirms computed values in the sheet, moves focus, replaces the sticky polite toast and resets with Undo', async () => {
  const { wrap } = setup()
  render(wrap(<div role="dialog"><button type="button">Primer control</button><dl><InformationAnalysis relPath="A/one.flac" track={{}} /></dl></div>))
  await user.click(await waitFor(() => screen.getByRole('button', { name: 'Confirmar tono 5A · Do menor' })))
  const bpm = await waitFor(() => screen.getByRole('button', { name: 'Confirmar 66 BPM' }))
  await waitFor(() => expect(bpm).toHaveFocus())
  expect(screen.getByText('Tono confirmado')).toBeInTheDocument()
  expect(screen.getByRole('img', { name: 'Corregido a mano' })).toBeInTheDocument()
  await user.click(bpm)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Primer control' })).toHaveFocus())
  expect(screen.queryByText('Tono confirmado')).toBeNull()
  expect(screen.getAllByRole('button', { name: 'Deshacer' })).toHaveLength(1)
  expect(screen.getByText('BPM confirmado').closest('ul')).toHaveAttribute('aria-live', 'polite')
  vi.useFakeTimers()
  await act(() => vi.advanceTimersByTimeAsync(31_000))
  expect(screen.getByText('BPM confirmado')).toBeInTheDocument()

  await user.click(screen.getByRole('button', { name: 'Deshacer' }))
  expect(await waitFor(() => screen.getByRole('button', { name: 'Confirmar 66 BPM' }))).toBeEnabled()
  expect(fake!.requests.filter(r => r.method === 'PUT').map(r => r.body)).toEqual([{ rev: 0, key: '5A' }, { rev: 1, bpm: 66 }, { rev: 2, bpm: null }])
})

it('reloads the newer computed value on a conflict without confirming it', async () => {
  const { wrap } = setup({ conflict: true })
  render(wrap(<dl><InformationAnalysis relPath="A/one.flac" track={{}} /></dl>))
  await user.click(await waitFor(() => screen.getByRole('button', { name: 'Confirmar tono 5A · Do menor' })))
  expect(await waitFor(() => screen.getByRole('button', { name: 'Confirmar tono 9B · Sol mayor' }))).toBeEnabled()
  expect(screen.getByText('El valor cambió en el nido. Se cargó la versión más reciente.')).toBeInTheDocument()
  expect(fake!.requests.filter(r => r.method === 'PUT')).toHaveLength(1)
  expect(fake!.requests.filter(r => decodeURIComponent(r.pathname) === '/api/analysis/A/one.flac').length).toBeGreaterThanOrEqual(2)
})

it('never offers sheet confirmation to a member', async () => {
  const { wrap } = setup({ member: true })
  render(wrap(<dl><InformationAnalysis relPath="A/one.flac" track={{}} /></dl>))
  await waitFor(() => screen.getByText('5A · Do menor'))
  expect(screen.queryByRole('button', { name: /Confirmar/ })).toBeNull()
})

it('pages the queue, names song actions, removes a confirmed row, focuses next and restores it on Undo', async () => {
  const { wrap } = setup({ paged: true, keysOnly: true })
  const play = vi.fn(), tags = vi.fn()
  render(wrap(<ReviewEstimates onPlay={play} onTags={tags} />))
  await user.click(await waitFor(() => screen.getByRole('button', { name: 'Cargar más' })))
  await waitFor(() => screen.getByText('Second Song'))
  expect(new URLSearchParams(fake!.requests.find(r => r.search.includes('after='))!.search).get('after')).toBe('A/one.flac')
  await user.click(screen.getByRole('button', { name: 'Escuchar Paper Satellites' }))
  expect(play).toHaveBeenCalledWith(expect.objectContaining({ relPath: 'A/one.flac' }))
  await user.click(screen.getByRole('button', { name: 'Abrir etiquetas Paper Satellites' }))
  expect(tags).toHaveBeenCalledWith(expect.objectContaining({ relPath: 'A/one.flac' }))
  expect(screen.getByRole('button', { name: 'Escuchar Paper Satellites' })).toHaveAttribute('title', 'Escuchar')
  expect(screen.queryByRole('checkbox')).toBeNull()
  expect(screen.queryByRole('button', { name: /todos/i })).toBeNull()
  await user.click(screen.getByRole('button', { name: 'Confirmar tono 5A · Do menor · Paper Satellites' }))
  await waitFor(() => expect(within(screen.getByRole('table')).queryByText('Paper Satellites')).toBeNull())
  expect(screen.getByRole('button', { name: 'Confirmar tono 5A · Do menor · Second Song' })).toHaveFocus()
  expect(screen.getByText('Paper Satellites · tono confirmado')).toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Deshacer' }))
  expect(await waitFor(() => within(screen.getByRole('table')).getByText('Paper Satellites'))).toBeInTheDocument()
  expect(fake!.requests.filter(r => r.method === 'PUT').map(r => r.body)).toEqual([{ rev: 0, key: '5A' }, { rev: 1, key: null }])
})

it('focuses the previous row then the header when the queue empties', async () => {
  const { wrap } = setup({ keysOnly: true })
  render(wrap(<ReviewEstimates onPlay={() => {}} onTags={() => {}} />))
  await user.click(await waitFor(() => screen.getByRole('button', { name: 'Confirmar tono 5A · Do menor · Second Song' })))
  const first = screen.getByRole('button', { name: 'Confirmar tono 5A · Do menor · Paper Satellites' })
  await waitFor(() => expect(first).toHaveFocus())
  await user.click(first)
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Revisar estimados' })).toHaveFocus())
  expect(screen.getByText('Sin datos', { exact: false })).toHaveClass('k-missing')
  expect(screen.queryByRole('table')).toBeNull()
})

it('has every confirmation and provenance line translated by hand in English', () => {
  const catalog = JSON.parse(readFileSync(resolve(__dirname, '../../locales/en/translation.json'), 'utf8'))
  for (const key of ["Confirm", "Review estimates", "Estimates", "Flipspin's calculation_noun", "File tag", "Key confirmed", "BPM confirmed", "Undo", "Play_listen", "Open tags", "Flipspin's estimate", ", Flipspin's estimate", "Confirm key {{value}}", "Confirm {{bpm}} BPM", "{{song}} · key confirmed", "{{song}} · BPM confirmed", "Play {{song}}_listen", "Open tags for {{song}}", "{{n}} keys_one", "{{n}} keys_other"]) expect(catalog[key], key).toBeTruthy()
})

it('opens Review estimates with the right row on click, Enter and Space without playing or editing', async () => {
  const { wrap } = setup()
  const onOpenInfo = vi.fn(), onPlay = vi.fn(), onTags = vi.fn()
  render(wrap(<ReviewEstimates onPlay={onPlay} onTags={onTags} onOpenInfo={onOpenInfo} />))
  const row = (await waitFor(() => screen.getByText('Second Song'))).closest('tr')!
  const buttons = within(row).getAllByRole('button', { name: 'Abrir información de la canción · Estimación de Flipspin' })
  expect(buttons).toHaveLength(2)
  for (const button of buttons) {
    await user.click(button)
    button.focus()
    await user.keyboard('{Enter}')
    await user.keyboard(' ')
  }
  expect(onOpenInfo).toHaveBeenCalledTimes(6)
  for (const [track] of onOpenInfo.mock.calls) expect(track).toMatchObject({ relPath: 'A/two.flac', title: 'Second Song' })
  expect(onPlay).not.toHaveBeenCalled()
  expect(onTags).not.toHaveBeenCalled()
  expect(fake!.requests.filter(request => request.method === 'PUT')).toEqual([])
})
