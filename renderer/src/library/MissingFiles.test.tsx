import { render, screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { DataProvider } from '../data'
import type { ApiData } from '../data'
import { installFakeSettings, type FakeSettings } from '../settings/test-support'
import { SettingsProvider, type SettingsContextValue } from '../settings/context'
import { MissingFiles } from './MissingFiles'
import { resolveSection, menuSection, sectionOf } from '../settings/sections'

let fake: FakeSettings
let client: QueryClient
afterEach(() => { fake?.restore(); client?.clear(); vi.restoreAllMocks() })
type Listing = ApiData<'/api/library/missing', 'get'>
const row: Listing['rows'][number] = { relPath: 'Album/song.mp3', path: 'Album/song.mp3', title: 'Night Ferry', cause: 'folder', folder: 'Album', size: 2000,
  missingSince: '2026-11-12T00:00:00Z', movedTo: null,
  references: { accounts: [{ id: 'member', name: 'Member' }], playlists: ['Evening'], playlistEntries: 1, corrections: ['key'], plays: 3, likes: 1, lyric: true, analysis: true, stems: false } }

function setup({ available = true, fail = false, admin = true, large = false } = {}) {
  fake = installFakeSettings({ respond: r => {
    if (r.pathname === '/api/library/edits/undo' && r.method === 'GET') return { status: 200, json: { id: 'undo', state: 'applied', rows: [{ rel_before: row.relPath, state: 'applied', reason: null }] } }
    if (r.pathname === '/api/library/missing') return fail ? { status: 500, json: {} } : { status: 200, json: { rows: [row, { ...row, relPath: 'Other/single.mp3', path: 'Other/single.mp3', title: 'Amber', cause: 'file', folder: '' }], libraryAvailable: available, libraryCount: large ? 2 : 20 } }
    if (r.pathname.endsWith('/preview')) return { status: 200, json: { rows: [{ relPath: row.relPath, target: 'New/song.mp3', rev: 'revision', reason: null }] } }
    if (r.pathname.endsWith('/apply') || r.pathname.endsWith('/remove')) return { status: 200, json: { editId: 'edit', rows: [{ relPath: row.relPath, state: 'applied', reason: null }] } }
    if (r.pathname.endsWith('/undo')) return { status: 202, json: { editId: 'undo' } }
  } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const context = { admin, go: vi.fn() } as unknown as SettingsContextValue
  render(<DataProvider queryClient={client}><SettingsProvider value={context}><MissingFiles /></SettingsProvider></DataProvider>)
  return { context, fake }
}

it('groups folder and individual causes and names dependencies and kept corrections', async () => {
  setup()
  expect(await screen.findByText('Folder not found')).toBeVisible()
  expect(screen.getByText('File not found')).toBeVisible()
  expect(screen.getByText('Album/')).toBeVisible()
  expect(screen.getAllByText(/1 account · Member/)[0]).toBeVisible()
  expect(screen.getAllByText(/corrections kept/)[0]).toBeVisible()
  expect(screen.getByRole('button', { name: 'Find the folder' })).toBeEnabled()
  expect(resolveSection('missing')).toBe('missing')
  expect(menuSection('missing')).toBe('biblioteca')
  expect(sectionOf('missing').admin).toBe(true)
})

it('previews filename matches and applies only after review', async () => {
  const { fake } = setup()
  await userEvent.click(await screen.findByRole('button', { name: 'Find the folder' }))
  const dialog = screen.getByRole('dialog')
  await userEvent.type(within(dialog).getByLabelText('Folder in music library'), 'New')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Preview' }))
  expect(await within(dialog).findByText('→ New/song.mp3')).toBeVisible()
  expect(fake.requests.some(r => r.pathname.endsWith('/apply'))).toBe(false)
  await userEvent.click(within(dialog).getByRole('button', { name: 'Apply 1 matches' }))
  await screen.findByText('1 song updated')
  expect(fake.requests.find(r => r.pathname.endsWith('/preview'))?.body).toEqual({ relPaths: [row.relPath], folder: 'New' })
  expect(fake.requests.find(r => r.pathname.endsWith('/apply'))?.body).toEqual({ rows: [{ relPath: row.relPath, target: 'New/song.mp3', rev: 'revision' }] })
})

it('shows removal losses and requires a separate counted large confirmation', async () => {
  const { fake } = setup({ large: true })
  await userEvent.click(await screen.findByRole('button', { name: 'Remove 1 song' }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByText('Account references')).toBeVisible()
  expect(within(dialog).getByText('Plays')).toBeVisible()
  expect(within(dialog).getByText('Corrections')).toBeVisible()
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remove 1 song' }))
  expect(fake.requests.some(r => r.pathname.endsWith('/remove'))).toBe(false)
  expect(within(dialog).getByRole('alert')).toHaveTextContent('1 of 2 library songs · more than 20%')
  await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm removal of 1 song' }))
  await screen.findByText('1 song updated')
  expect(fake.requests.find(r => r.pathname.endsWith('/remove'))?.body).toEqual({ relPaths: [row.relPath], confirmLarge: true })
  await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
  await waitFor(() => expect(fake.requests.some(r => r.pathname.endsWith('/undo'))).toBe(true))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument())
})

it('disables mutations while the root is unavailable', async () => {
  setup({ available: false })
  expect(await screen.findByRole('alert')).toHaveTextContent('Music folder unavailable')
  expect(screen.getByRole('button', { name: 'Find the folder' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled()
})

it('shows a retry for listing errors', async () => {
  setup({ fail: true })
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load missing files')
  expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible()
})

it('makes no owner listing request for members', async () => {
  const { fake } = setup({ admin: false })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(fake.requests.some(r => r.pathname === '/api/library/missing')).toBe(false)
})
