import { changeHandler } from '../data/changes'
import { act, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { AccountBlock } from '../shell/layout/header'
import { DataProvider, queryKeys } from '../data'
import { installFakeSettings, type FakeSettings } from '../settings/test-support'
import { useAttention, type Attention } from './useAttention'
import type { MacEngineStatus } from '../lib/ipc'

let fake: FakeSettings | undefined
afterEach(() => { fake?.restore(); vi.restoreAllMocks() })

const helper = (state: NonNullable<Attention['helper']>['state']): NonNullable<Attention['helper']> => ({
  id: 'h1', name: 'big_chip', state, version: '0.7.2', waiting: 121,
  lastSeenAt: Date.now() / 1000 - 7200, minimumVersion: '0.8.0', progress: null,
})
const update = { latest: '2.2.0', current: '2.1.2', skipped: null, show: true }

function setup(value: Attention, { owner = true, supported = false } = {}) {
  fake = installFakeSettings({
    macEngine: { supported } as MacEngineStatus,
    respond: request => request.pathname === '/api/me/attention' ? { status: 200, json: value } : undefined,
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // A cached owner snapshot must not leak when the menu renders for a member.
  client.setQueryData(queryKeys.me.attention(), value)
  const view = render(<DataProvider queryClient={client}><AccountBlock name="Ana" account={{ role: owner ? 'owner' : 'member', isOwner: owner }} /></DataProvider>)
  return { ...view, client }
}

it.each([
  { flag: 'version', tone: 'info', label: 'Nueva versión disponible', color: 'var(--teal)' },
  { flag: 'helper', tone: 'warn', label: 'Equipo necesita atención · trabajo en espera', color: 'var(--yellow)' },
  { flag: 'helper', tone: 'bad', label: 'Equipo sin conexión · trabajo en espera', color: 'var(--rose)' },
] as const)('shows the owner $tone dot without clearing it on open', async ({ flag, tone, label, color }) => {
  setup({ version: update, helper: helper(tone === 'bad' ? 'offline' : 'asleep'), helpers: 1, flag, flagTone: tone })
  const dot = await screen.findByRole('img', { name: label })
  expect(dot).toHaveStyle({ background: color })
  expect(screen.getByRole('button', { name: /Ana, nido:/ })).toHaveAccessibleName(expect.stringContaining(label))
  await userEvent.click(screen.getByRole('button', { name: /Ana, nido:/ }))
  expect(screen.getByRole('img', { name: label })).toBeInTheDocument()
  await waitFor(() => expect(fake!.requests.filter(r => r.pathname === '/api/me/attention').length).toBeGreaterThan(0))
  expect(fake!.requests.every(r => r.method === 'GET')).toBe(true)
})

it('keeps a member menu unchanged even with a cached owner snapshot', async () => {
  setup({ version: update, helper: helper('offline'), flag: 'helper', flagTone: 'bad', helpers: 1 }, { owner: false, supported: true })
  await userEvent.click(screen.getByRole('button', { name: /Ana, nido:/ }))
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
  expect(screen.getAllByRole('menuitem').map(el => el.textContent)).toEqual(['Mi cuenta', 'Nido', 'Ajustes'])
  expect(fake!.requests.some(r => r.pathname === '/api/me/attention')).toBe(false)
})

it.each([true, false])('offers this Mac only when supported=%s', async supported => {
  setup({ version: null, helper: null, helpers: 0, flag: null, flagTone: null }, { supported })
  await userEvent.click(screen.getByRole('button', { name: /Ana, nido:/ }))
  await waitFor(() => expect(fake!.invocations.some(r => r.channel === 'lyrics:engine-status')).toBe(true))
  if (supported) expect(await screen.findByRole('menuitem', { name: 'Procesar para el nido' })).toBeInTheDocument()
  else expect(screen.queryByRole('menuitem', { name: 'Procesar para el nido' })).not.toBeInTheDocument()
  expect(screen.queryByRole('img')).not.toBeInTheDocument()
})

it('opens the version card through the settings event and refreshes again on reopening', async () => {
  setup({ version: update, helper: null, helpers: 0, flag: 'version', flagTone: 'info' })
  const events: unknown[] = []
  const listen = (event: Event) => events.push((event as CustomEvent).detail)
  window.addEventListener('krobi-show-settings', listen)
  try {
    await userEvent.click(screen.getByRole('button', { name: /Ana, nido:/ }))
    await userEvent.click(screen.getByRole('menuitem', { name: /Flipspin 2.2.0/ }))
    expect(events).toEqual([{ section: 'version' }])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    const before = fake!.requests.filter(r => r.pathname === '/api/me/attention').length
    await userEvent.click(screen.getByRole('button', { name: /Ana, nido:/ }))
    await waitFor(() => expect(fake!.requests.filter(r => r.pathname === '/api/me/attention').length).toBeGreaterThan(before))
  } finally { window.removeEventListener('krobi-show-settings', listen) }
})

it.each([
  ['idle', 'Libre', '0.7.2'], ['working', 'Trabajando', '3 / 121'],
  ['asleep', 'Dormida', '121 en espera'], ['closed', 'Cerrada', '121 en espera'],
  ['offline', 'Sin conexión', 'hace 2 h'], ['outdated', 'Desactualizada', '0.7.2 → 0.8.0'],
] as const)('renders the canvas word and real fact for %s', async (state, word, fact) => {
  const selected = helper(state)
  if (state === 'working') selected.progress = { done: 3, total: 121 }
  setup({ helper: selected, helpers: 1, version: null, flag: null, flagTone: null })
  await userEvent.click(screen.getByRole('button', { name: /Ana, nido:/ }))
  expect(screen.getByText(word)).toBeInTheDocument()
  expect(screen.getByText(`· ${fact}`)).toBeInTheDocument()
})

it('re-probes offline state and opens the release for an outdated helper', async () => {
  const external = vi.spyOn(window, 'open').mockImplementation(() => null)
  const { client } = setup({ helper: helper('offline'), helpers: 1 })
  await userEvent.click(screen.getByRole('button', { name: /Ana, nido:/ }))
  const retry = await screen.findByRole('menuitem', { name: 'Reintentar' })
  await waitFor(() => expect(retry).toBeEnabled())
  const before = fake!.requests.length
  await userEvent.click(retry)
  await waitFor(() => expect(fake!.requests.length).toBeGreaterThan(before))
  await act(async () => { client.setQueryData(queryKeys.me.attention(), { helper: helper('outdated'), helpers: 1 }) })
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Actualizar' }))
  expect(external).toHaveBeenCalledWith('https://github.com/flipspin/flipspin/releases/latest', '_blank', 'noopener,noreferrer')
})

it('refreshes owner attention on helper events without an idle timer', async () => {
  vi.useFakeTimers()
  fake = installFakeSettings({ respond: r => r.pathname === '/api/me/attention' ? { status: 200, json: { flag: null } } : undefined })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const changes = changeHandler(client)
  const view = renderHook(() => useAttention(true, false), {
    wrapper: ({ children }) => <DataProvider queryClient={client}>{children}</DataProvider>,
  })
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    const count = () => fake!.requests.filter(r => r.pathname === '/api/me/attention').length
    expect(count()).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999) })
    expect(count()).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(count()).toBe(1)
    await act(async () => { changes.changed({ area: 'helpers', rev: 1 }); await vi.advanceTimersByTimeAsync(0) })
    expect(count()).toBe(2)
  } finally { changes.dispose(); view.unmount(); client.clear(); vi.useRealTimers() }
})
