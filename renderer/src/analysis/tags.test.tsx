import { afterEach, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AnalysisFields } from './AnalysisFields'
import TrackTagsModal from '../albums/TrackTagsModal'
import type { SchemaAnalysisView } from '../api/generated/schema'
import { installFakeSettings, type FakeSettings, type ResponseSpec } from '../settings/test-support'

let fake: FakeSettings | undefined
afterEach(() => { fake?.restore(); fake = undefined })
const initial = (): SchemaAnalysisView => ({ key: { value: '5A', estimated: true, source: 'computed' }, bpm: { value: 66, estimated: true, source: 'computed' }, computed: { key: '5A', bpm: 66, keyEstimated: true, bpmEstimated: true }, fixed: { key: null, bpm: null }, rev: 3, state: 'analyzed', mood: null, energy: null, brightness: null, pulse: null })
function setup({ view = initial(), failure, conflict }: { view?: SchemaAnalysisView; failure?: ResponseSpec; conflict?: SchemaAnalysisView } = {}) {
  let current = view
  fake = installFakeSettings({ respond: request => {
    const path = decodeURIComponent(request.pathname)
    if (path === '/api/me') return { status: 200, json: { role: 'owner', isOwner: true } }
    if (request.method === 'PUT') {
      if (conflict) { current = conflict; return { status: 409, json: current } }
      if (failure) return failure
      const body = request.body as { key?: string | null; bpm?: number | null }
      current = structuredClone(current)
      for (const field of ['key', 'bpm'] as const) if (field in body) {
        const value = body[field]!
        current[field] = { value: value ?? current.computed[field], source: value == null ? 'computed' : 'fixed', estimated: value == null }
        if (field === 'key') current.fixed.key = value as string | null
        else current.fixed.bpm = value as number | null
      }
      current.rev++
    }
    return { status: 200, json: current }
  } })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return { wrap: (node: React.ReactNode) => <QueryClientProvider client={client}>{node}</QueryClientProvider> }
}

it.each(['estimate', 'computed', 'tag', 'fixed'] as const)('renders the closed Tono control for %s', async state => {
  const view = initial()
  if (state !== 'estimate') view.key.estimated = false
  if (state === 'tag') view.key.source = 'tag'
  if (state === 'fixed') { view.key.source = 'fixed'; view.fixed.key = '2A'; view.key.value = '2A' }
  const { wrap } = setup({ view })
  render(wrap(<AnalysisFields relPath="Album/song.flac" />))
  const select = await screen.findByRole('button', { name: 'Tono' })
  expect(select).toHaveTextContent(state === 'fixed' ? '2A' : 'Automático')
  expect(select.querySelector('.analysis-value--estimated') !== null).toBe(state === 'estimate')
  if (state === 'estimate') {
    expect(select).toHaveTextContent('≈ 5A')
    expect(select.querySelector('.analysis-value__number')).toHaveTextContent('5A')
    expect(select.querySelector('.analysis-source')).toBeNull()
    expect(select.querySelector('.analysis-value--estimated')!).toBeInTheDocument()
    expect(within(select).getByText(', estimado')).toHaveClass('k-sr-only')
  } else {
    const label = { computed: 'Cálculo de Flipspin', tag: 'Etiqueta del archivo', fixed: 'Corregido a mano' }[state]
    expect(within(select).getByRole('img', { name: label })).toBeInTheDocument()
    expect(select).not.toHaveTextContent('≈')
  }
})

it('pins Automatic before two twelve-key groups and highlights the computed key after a correction', async () => {
  const view = initial(); view.fixed.key = '2A'; view.key = { value: '2A', estimated: false, source: 'fixed' }
  const { wrap } = setup({ view })
  render(wrap(<AnalysisFields relPath="Album/song.flac" />))
  await userEvent.click(await screen.findByRole('button', { name: 'Tono' }))
  const list = screen.getByRole('listbox')
  const options = within(list).getAllByRole('option')
  expect(options).toHaveLength(25)
  expect(options[0]).toHaveTextContent('Automático≈ 5A')
  expect(options[0]).toHaveAttribute('data-pinned', 'true')
  for (const group of ['Menor', 'Mayor']) expect(within(within(list).getByRole('group', { name: group })).getAllByRole('option')).toHaveLength(12)
  expect(options[1]).toHaveTextContent('1A · La♭ menor')
  expect(options[13]).toHaveTextContent('1B · Si mayor')
  expect(within(list).getByRole('option', { name: '5A · Do menor' })).toHaveAttribute('data-emphasized', 'true')
  expect(within(list).getByRole('option', { name: '2A · Mi♭ menor' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.queryByRole('button', { name: /Usar automático · 5A/ })).toBeNull()
})

it.each(['2A · Mi♭ menor', '5A · Do menor', 'Automático≈ 5A'])('saves choosing %s, restores focus and supports Undo after confirmation', async name => {
  const { wrap } = setup()
  const changed = vi.fn()
  render(wrap(<AnalysisFields relPath="Album/song.flac" onChanged={changed} />))
  const select = await screen.findByRole('button', { name: 'Tono' })
  await userEvent.click(select)
  await userEvent.click(screen.getByRole('option', { name }))
  const key = name.startsWith('2') ? '2A' : name.startsWith('5') ? '5A' : null
  await waitFor(() => expect(fake!.requests.filter(r => r.method === 'PUT').map(r => r.body)).toEqual([{ rev: 3, key }]))
  await waitFor(() => expect(select).toBeEnabled())
  expect(select).toHaveFocus()
  expect(changed).toHaveBeenCalled()
  expect(screen.queryByRole('listbox')).toBeNull()
  if (key) {
    expect(screen.getByText('Tono confirmado')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Deshacer' }))
    await waitFor(() => expect(select).toHaveTextContent('Automático≈ 5A'))
    expect(fake!.requests.filter(r => r.method === 'PUT').map(r => r.body)).toEqual([{ rev: 3, key }, { rev: 4, key: null }])
  }
})

it('has a decimal BPM input with an inset unit and confirms the computed BPM through the shared toast', async () => {
  const { wrap } = setup()
  render(wrap(<AnalysisFields relPath="Album/song.flac" />))
  const bpm = await screen.findByRole('spinbutton', { name: 'BPM' })
  expect(bpm).toHaveAttribute('min', '20')
  expect(bpm).toHaveAttribute('max', '300')
  expect(bpm).toHaveAttribute('step', 'any')
  expect(bpm).toHaveAccessibleDescription('Estimado')
  expect(bpm.parentElement!.querySelector('.analysis-bpm-unit')).toHaveTextContent('BPM')
  expect(bpm.parentElement!.querySelector('.analysis-value--estimated')).toHaveTextContent('≈ 66')
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar 66' }))
  await screen.findByText('BPM confirmado')
  expect(fake!.requests.filter(r => r.method === 'PUT').map(r => r.body)).toEqual([{ rev: 3, bpm: 66 }])
  expect(screen.queryByRole('button', { name: 'Confirmar 66' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Usar automático · 66' })).toBeEnabled()
  await userEvent.click(screen.getByRole('button', { name: 'Deshacer' }))
  expect(await screen.findByRole('button', { name: 'Confirmar 66' })).toBeEnabled()
  expect(fake!.requests.filter(r => r.method === 'PUT').map(r => r.body)).toEqual([{ rev: 3, bpm: 66 }, { rev: 4, bpm: null }])
})

it('allows keyboard selection in the modal and Escape closes only the list', async () => {
  const { wrap } = setup()
  const close = vi.fn()
  render(wrap(<TrackTagsModal open track={{ path: '/music/Album/song.flac', relPath: 'Album/song.flac' }} onClose={close} onSave={() => {}} />))
  const select = await screen.findByRole('button', { name: 'Tono' })
  await userEvent.click(select)
  await userEvent.keyboard('{Escape}')
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(close).not.toHaveBeenCalled()
  expect(select).toHaveFocus()
  await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}')
  await waitFor(() => expect(fake!.requests.filter(r => r.method === 'PUT').map(r => r.body)).toEqual([{ rev: 3, key: '1A' }]))
  await waitFor(() => expect(select).toHaveFocus())
  expect(close).not.toHaveBeenCalled()
})

it.each(['key', 'bpm'] as const)('keeps a 422 %s validation message inline without a success toast', async field => {
  const { wrap } = setup({ failure: { status: 422, json: { detail: [{ msg: 'Valor fuera de rango' }] } } })
  render(wrap(<AnalysisFields relPath="Album/song.flac" />))
  const select = await screen.findByRole('button', { name: 'Tono' })
  if (field === 'key') {
    await userEvent.click(select)
    await userEvent.click(screen.getByRole('option', { name: '5A · Do menor' }))
  } else await userEvent.click(screen.getByRole('button', { name: 'Confirmar 66' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Valor fuera de rango')
  expect(screen.queryByRole('button', { name: 'Deshacer' })).toBeNull()
  expect(select).toHaveTextContent('Automático≈ 5A')
})

it('restores the BPM estimate after editing back to the automatic value', async () => {
  const { wrap } = setup()
  render(wrap(<AnalysisFields relPath="Album/song.flac" />))
  const bpm = await screen.findByRole('spinbutton', { name: 'BPM' })
  await userEvent.click(bpm)
  fireEvent.change(bpm, { target: { value: '66' } })
  fireEvent.blur(bpm)
  expect(bpm.parentElement!.querySelector('.analysis-value--estimated')).toHaveTextContent('≈ 66')
  expect(fake!.requests.filter(r => r.method === 'PUT')).toHaveLength(0)
})

it('includes the hand-written English labels', () => {
  const catalog = JSON.parse(readFileSync(resolve(__dirname, '../../locales/en/translation.json'), 'utf8'))
  expect(Object.fromEntries(["Automatic", "Minor", "Major", "Confirm {{value}}"].map(key => [key, catalog[key]]))).toEqual({ "Automatic": 'Automatic', Minor: 'Minor', Major: 'Major', "Confirm {{value}}": 'Confirm {{value}}' })
})


it('reloads a conflicting BPM confirmation and keeps the newer estimate editable', async () => {
  const conflict = initial(); conflict.rev = 9; conflict.computed.bpm = 72; conflict.bpm.value = 72
  const { wrap } = setup({ conflict })
  render(wrap(<AnalysisFields relPath="Album/song.flac" />))
  await userEvent.click(await screen.findByRole('button', { name: 'Confirmar 66' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('El valor cambió en el nido. Se cargó la versión más reciente.')
  expect(screen.getByRole('spinbutton', { name: 'BPM' })).toHaveValue(72)
  expect(screen.getByRole('button', { name: 'Confirmar 72' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: 'Deshacer' })).toBeNull()
  expect(fake!.requests.filter(r => r.method === 'PUT').map(r => r.body)).toEqual([{ rev: 3, bpm: 66 }])
})

it.each(['mp3', 'flac', 'ogg', 'm4a', 'wav', 'aiff'])('keeps analysis editable for owners with %s files', async format => {
  const { wrap } = setup()
  render(wrap(<TrackTagsModal open track={{ path: `/music/Album/song.${format}`, relPath: `Album/song.${format}` }} onClose={() => {}} onSave={() => {}} />))
  expect(await screen.findByRole('button', { name: 'Tono' })).toBeEnabled()
  expect(screen.getByRole('spinbutton', { name: 'BPM' })).toBeEnabled()
  expect(screen.getByRole('textbox', { name: 'Título' })).toHaveAttribute('readonly') // No tag-read fixture; metadata stays read-only until loaded.
})

it('exposes the active key to keyboard users and tabs from the list to BPM', async () => {
  const { wrap } = setup()
  render(wrap(<AnalysisFields relPath="Album/song.flac" />))
  await userEvent.click(await screen.findByRole('button', { name: 'Tono' }))
  const list = screen.getByRole('listbox', { name: 'Tono' })
  expect(list).toHaveFocus()
  await userEvent.keyboard('{ArrowDown}')
  expect(document.getElementById(list.getAttribute('aria-activedescendant')!)).toHaveTextContent('1A · La♭ menor')
  await userEvent.tab()
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(screen.getByRole('spinbutton', { name: 'BPM' })).toHaveFocus()
})
