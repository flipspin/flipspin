import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { DataProvider } from '../../data'
import { installFakeSettings, type FakeSettings } from '../test-support'
import i18n from '../../i18n'
import { DuplicateResults } from './Duplicates'
import { SettingsPage } from '../SettingsPage'
import { duplicatesKey, type DuplicateList } from '../duplicatesData'
import { menuSection, resolveSection } from '../sections'

const base = '/api/library/duplicates'
let fake: FakeSettings | undefined
let client: QueryClient
const original: DuplicateList = {
  jobId: 'job', state: 'succeeded', audio: 'unavailable', audioSkipped: 0,
  groups: [{ groupId: 'one', basis: 'tags', title: 'Song', artist: 'Artist', keeper: 'Album/song.flac', files: [
    { relPath: 'Album/song.flac', title: 'Song', artist: 'Artist', album: 'Album', format: 'FLAC', bitrate: 1012, duration: 301, plays: 41, missing: false, difference: { format: false, bitrate: 0, duration: 0, plays: 0 } },
    { relPath: 'Album/song.mp3', title: 'Song', artist: 'Artist', album: 'Album', format: 'MP3', bitrate: 320, duration: 300, plays: 12, missing: false, difference: { format: true, bitrate: -692, duration: -1, plays: -29 } },
  ] }],
}
beforeEach(async () => { await i18n.changeLanguage('en') })
afterEach(async () => { fake?.restore(); client?.clear(); vi.restoreAllMocks(); await i18n.changeLanguage('es') })

function setup({ initial = original, fail = 0, readError = 0, whole = false, member = false, section = 'duplicates' } = {}) {
  let data = structuredClone(initial)
  fake = installFakeSettings({ respond: r => {
    if (r.pathname === '/api/me') return { status: 200, json: { id: 'test', label: 'Test', isOwner: !member, role: member ? 'member' : 'owner', source: 'token' } }
    if (r.pathname === base) return { status: readError || 200, json: readError ? { detail: 'Not Found' } : data }
    if (r.pathname === base + '/scan') {
      data = { ...data, state: 'running', jobId: 'next-job' }
      return { status: fail || 202, json: { jobId: 'next-job' } }
    }
    if (r.pathname.endsWith('/keeper')) {
      if (fail) return { status: fail, json: { detail: 'group-changed' } }
      data.groups[0].keeper = (r.body as { keep: string }).keep
      return { status: 200, json: data }
    }
    if (r.pathname.endsWith('/dismiss')) {
      if (fail) return { status: fail, json: { detail: 'group-changed' } }
      data = { ...data, groups: [] }
      return { status: 200, json: data }
    }
    if (r.pathname === '/api/library/summary') return { status: 200, json: { folder: '/music', songs: 2, albums: 1, artists: 1 } }
    return undefined
  } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<DataProvider queryClient={client}>{whole ? <SettingsPage initialSection={section} surface="dev" host={{ palette: 'paper', setPalette: vi.fn(), palettes: [], mode: 'light', setMode: vi.fn() }} /> : <DuplicateResults />}</DataProvider>)
  return fake
}

it('shows English match level, selected keeper, four differences, and the skipped audio level', async () => {
  setup()
  expect(await screen.findByText('Same tags')).toBeVisible()
  expect(screen.getByText('2 copies')).toBeVisible()
  expect(screen.getByText('Keep')).toBeVisible()
  expect(screen.getByText('Same audio skipped · fpcalc unavailable on the nest')).toBeVisible()
  expect(screen.getByText('−692')).toBeVisible()
  expect(screen.getByText('−0:01')).toBeVisible()
  expect(screen.getByText('−29')).toBeVisible()
  expect(screen.getByText('MP3')).toHaveAttribute('data-different', 'true')
  expect(screen.queryByRole('button', { name: /delete|remove|merge/i })).not.toBeInTheDocument()
  expect(fake!.requests.every(r => r.method === 'GET')).toBe(true)
})

it('changes only a keeper preference through the typed endpoint', async () => {
  setup()
  await userEvent.click(await screen.findByRole('button', { name: 'Choose another to keep' }))
  await userEvent.click(screen.getByRole('radio', { name: 'Keep Album/song.mp3' }))
  await userEvent.click(screen.getByRole('button', { name: 'Save preference' }))
  await waitFor(() => expect(screen.queryByRole('radio')).not.toBeInTheDocument())
  expect(fake!.requests.find(r => r.method === 'PUT')).toMatchObject({ pathname: base + '/one/keeper', body: { keep: 'Album/song.mp3' } })
  expect(screen.getByText('Album/song.mp3').closest('tr')).toHaveAttribute('data-keeper', 'true')
})

it('dismisses the group without a delete or merge request', async () => {
  setup()
  await userEvent.click(await screen.findByRole('button', { name: 'Not duplicates' }))
  expect(await screen.findByText('No possible duplicates')).toBeVisible()
  expect(fake!.requests.filter(r => r.method !== 'GET')).toMatchObject([{ method: 'POST', pathname: base + '/one/dismiss' }])
})

it('disables unavailable copies and shows missing measurements as words', async () => {
  const initial = structuredClone(original)
  Object.assign(initial.groups[0].files[1], { missing: true, bitrate: null, duration: null })
  setup({ initial })
  await userEvent.click(await screen.findByRole('button', { name: 'Choose another to keep' }))
  expect(screen.getByRole('radio', { name: 'Keep Album/song.mp3' })).toBeDisabled()
  expect(screen.getByText('Unavailable')).toBeVisible()
  expect(screen.getAllByText('Not measured')).toHaveLength(2)
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(fake!.requests.every(r => r.method === 'GET')).toBe(true)
})

it('starts a background scan, disables actions while running, and displays the result', async () => {
  setup({ initial: { ...original, state: 'idle', jobId: null, groups: [], audio: 'not-scanned' } })
  await userEvent.click(await screen.findByRole('button', { name: 'Find duplicates' }))
  expect(await screen.findByText('Finding duplicates…')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Find duplicates' })).toBeDisabled()
  expect(fake!.requests.find(r => r.pathname.endsWith('/scan'))?.method).toBe('POST')
  await act(async () => { client.setQueryData(duplicatesKey, original) })
  expect(await screen.findByText('Same tags')).toBeVisible()
})

it.each([409, 500])('reports a refused preference (%s) and retains the group', async fail => {
  setup({ fail })
  await userEvent.click(await screen.findByRole('button', { name: 'Not duplicates' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(fail === 409 ? 'Group changed. Scan for duplicates again.' : "Couldn't save preference")
  expect(screen.getByText('Same tags')).toBeVisible()
})

it('shows a failed scan and allows retry', async () => {
  setup({ initial: { ...original, state: 'interrupted' } })
  expect(await screen.findByRole('alert')).toHaveTextContent("Duplicate scan didn't finish")
  expect(screen.getByRole('button', { name: 'Find duplicates' })).toBeEnabled()
})

it('reports an unavailable scanner and allows retry', async () => {
  setup({ fail: 500 })
  await userEvent.click(await screen.findByRole('button', { name: 'Find duplicates' }))
  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't start duplicate scan")
  expect(screen.getByRole('button', { name: 'Find duplicates' })).toBeEnabled()
})

it('handles old nests with a concise update status', async () => {
  setup({ readError: 404 })
  expect(await screen.findByText('Update the nest to find duplicates.')).toBeVisible()
})

it('opens the list from Library and keeps Library selected in the settings menu', async () => {
  setup({ whole: true, section: 'biblioteca' })
  await userEvent.click(await screen.findByRole('button', { name: 'Review duplicates' }))
  expect(await screen.findByRole('heading', { name: 'Possible duplicates' })).toBeVisible()
  expect(screen.getByText('Same tags')).toBeVisible()
  expect(menuSection('duplicates')).toBe('biblioteca')
  expect(resolveSection('duplicates')).toBe('duplicates')
  const breadcrumb = screen.getAllByRole('button', { name: 'Library' }).find(button => !button.hasAttribute('aria-current'))!
  await userEvent.click(breadcrumb)
  expect(await screen.findByRole('button', { name: 'Review duplicates' })).toBeVisible()
})

it('blocks member deep links before any duplicate request', async () => {
  setup({ whole: true, member: true })
  await screen.findByRole('heading', { name: 'Overview' })
  expect(fake!.requests.some(r => r.pathname.startsWith(base))).toBe(false)
  expect(screen.queryByRole('heading', { name: 'Possible duplicates' })).not.toBeInTheDocument()
})

it('shows the audio level and individual fingerprint skips', async () => {
  const initial = structuredClone(original)
  initial.audio = 'available'; initial.audioSkipped = 2; initial.groups[0].basis = 'audio'
  setup({ initial })
  expect(await screen.findByText('Same audio')).toBeVisible()
  expect(screen.getByText('2 files without audio fingerprints')).toBeVisible()
  const table = screen.getByRole('table')
  expect(within(table).getAllByRole('columnheader')).toHaveLength(6)
})
