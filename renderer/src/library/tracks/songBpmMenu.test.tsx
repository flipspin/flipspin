import { installTestClock, waitForClock as waitFor } from '../../test/test-clock'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import i18n from '../../i18n'
import { installFakeSettings, type FakeSettings } from '../../settings/test-support'
import type { SchemaAnalysisView } from '../../api/generated/schema'
import { analysisKeys } from '../../analysis/data'
import TrackContextMenu from '../../albums/TrackContextMenu'
import { songMenuItems } from './songMenuItems'
import { useSongBpmMenu, type BpmSong } from './useSongBpmMenu'

installTestClock()


let fake: FakeSettings | undefined
afterEach(async () => { vi.restoreAllMocks(); fake?.restore(); fake = undefined; await i18n.changeLanguage('es') })
function Harness({ songs }: { songs: BpmSong[] }) {
  const bpmMenu = useSongBpmMenu()
  return <TrackContextMenu open x={0} y={0} onClose={() => {}} items={songMenuItems({ onPlay() {}, onPlayNext() {}, onQueue() {}, bpmItems: bpmMenu(songs) })} />
}
function setup(songs: BpmSong[], { member = false, conflicts = [] as string[], failures = [] as string[], delay = false } = {}) {
  const views = new Map<string, SchemaAnalysisView>(songs.map((song, i) => [song.relPath!, {
    rev: typeof song.rev === 'number' ? song.rev : i + 3,
    bpm: { value: song.bpm as number, source: 'computed', estimated: true },
    fixed: { key: null, bpm: song.bpmSource === 'fixed' ? song.bpm as number : null },
    computed: { bpm: song.bpm as number, key: null, bpmEstimated: true, keyEstimated: false },
    key: { value: null, source: null, estimated: false },
    state: 'analyzed', mood: null, energy: null, brightness: null, pulse: null,
  } satisfies SchemaAnalysisView]))
  let inFlight = 0
  let peak = 0
  const releases: (() => void)[] = []
  fake = installFakeSettings({ respond: request => {
    const path = decodeURIComponent(request.pathname)
    if (path === '/api/me') return { status: 200, json: { isOwner: !member, role: member ? 'member' : 'owner' } }
    const key = path.replace(/^\/api\/analysis\//, '').replace(/\/fixed$/, '')
    const view = views.get(key)
    if (view) {
      if (request.method === 'PUT') {
        if (failures.includes(key)) return { status: 422, json: { detail: 'Invalid BPM' } }
        const body = request.body as { rev: number; bpm: number | null }
        if (conflicts.includes(key) || body.rev !== view.rev) {
          view.rev++
          return { status: 409, json: view }
        }
        view.rev++
        view.fixed.bpm = body.bpm
        view.bpm = { value: body.bpm ?? view.computed.bpm!, source: body.bpm === null ? 'computed' : 'fixed', estimated: body.bpm === null }
      }
      // Clone: a recorded GET response must not change on the following PUT.
      return { status: 200, json: structuredClone(view) }
    }
    return { status: 200, json: {} }
  } })
  if (delay) {
    const fetchNow = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      const url = String(args[0] instanceof Request ? args[0].url : args[0])
      if (url.includes('/api/analysis/')) {
        inFlight++; peak = Math.max(peak, inFlight)
        await new Promise<void>(done => releases.push(done))
        try { return await fetchNow(...args) } finally { inFlight-- }
      }
      return fetchNow(...args)
    })
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rendered = render(<QueryClientProvider client={client}><Harness songs={songs} /></QueryClientProvider>)
  return { client, views, rendered, releases, peak: () => peak, puts: () => fake!.requests.filter(r => r.method === 'PUT'), gets: (key: string) => fake!.requests.filter(r => r.method === 'GET' && decodeURIComponent(r.pathname) === `/api/analysis/${key}`) }
}
const song = (bpm: unknown = 94, relPath = 'Album/song.flac'): BpmSong => ({ relPath, bpm })
const double = 'Duplicar BPM'
const halve = 'Reducir BPM a la mitad'

describe('shared song-menu BPM actions', () => {
  it('previews a single result, counts each eligible subset and disables zero results', async () => {
    const { rendered, client } = setup([song()])
    expect(await waitFor(() => screen.getByRole('menuitem', { name: `${double} · 94 → 188` }))).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: `${halve} · 94 → 47` })).toBeInTheDocument()
    const songs = [song(40, 'a'), song(150, 'b'), song(151, 'c'), song(39, 'd'), song(null, 'e')]
    rendered.rerender(<QueryClientProvider client={client}><Harness songs={songs} /></QueryClientProvider>)
    expect(await waitFor(() => screen.getByRole('menuitem', { name: `${double} · 3 canciones` }))).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: `${halve} · 3 canciones` })).toBeInTheDocument()
    rendered.rerender(<QueryClientProvider client={client}><Harness songs={[song(151)]} /></QueryClientProvider>)
    expect(await waitFor(() => screen.getByRole('menuitem', { name: `${double} · 0 canciones` }))).toHaveAttribute('aria-disabled', 'true')
  })

  it('hides both actions for members', async () => {
    const { client } = setup([song()], { member: true })
    await waitFor(() => expect(client.getQueryData(['me', 'profile'])).toEqual(expect.objectContaining({ isOwner: false })))
    expect(screen.queryByRole('menuitem', { name: /Duplicar BPM|Reducir BPM/ })).toBeNull()
  })

  it('hides both actions for a wholly missing or invalid selection', async () => {
    const { client } = setup([song(null, 'a'), song(NaN, 'b'), song(0, 'c'), song(Infinity, 'd')])
    await waitFor(() => expect(client.getQueryData(['me', 'profile'])).toBeTruthy())
    expect(screen.queryByRole('menuitem', { name: /Duplicar BPM|Reducir BPM/ })).toBeNull()
  })

  it.each([{ factor: double, bpms: [40, 150, 151], results: [80, 300] }, { factor: halve, bpms: [40, 150, 39], results: [20, 75] }])('skips missing/invalid/out-of-range songs when using $factor', async ({ factor, bpms, results }) => {
    const songs = [...bpms, null, 0, -2, NaN, Infinity].map((bpm, i) => song(bpm, `Album/${i}.flac`))
    const { puts } = setup(songs)
    fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: `${factor} · 2 canciones` })))
    expect(await waitFor(() => screen.getByText(`${factor === double ? 'Duplicadas' : 'Reducidas a la mitad'} 2 · 6 omitidas`))).toBeInTheDocument()
    expect(puts().map(r => (r.body as { bpm: number }).bpm)).toEqual(results)
  })

  it('counts a 409, reloads that song, and offers Undo only for successful songs', async () => {
    const { puts, gets, client } = setup([song(94, 'a'), song(100, 'b')], { conflicts: ['a'] })
    fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: `${double} · 2 canciones` })))
    expect(await waitFor(() => screen.getByText('Duplicadas 1 · 1 omitidas'))).toBeInTheDocument()
    expect(puts()).toHaveLength(2)
    expect(gets('a')).toHaveLength(2)
    expect(client.getQueryData(analysisKeys.track('a'))).toEqual(expect.objectContaining({ rev: 4 }))
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }))
    await waitFor(() => screen.getByText('BPM restaurado en 1 canción'))
    expect(puts().slice(2).map(r => [decodeURIComponent(r.pathname), r.body])).toEqual([['/api/analysis/b/fixed', { rev: 5, bpm: null }]])
  })

  it('keeps one sticky toast and restores mixed fixed/automatic states with each post-save revision', async () => {
    const songs = [song(94, 'Album/auto.flac'), { ...song(90, 'Album/fixed.flac'), bpmSource: 'fixed', rev: 10 }]
    const { puts, gets, views, rendered } = setup(songs)
    fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: `${double} · 2 canciones` })))
    await waitFor(() => screen.getByText('BPM duplicado en 2 canciones'))
    expect(gets('Album/auto.flac')).toHaveLength(1)
    expect(gets('Album/fixed.flac')).toHaveLength(0)
    expect(puts().map(r => r.body)).toEqual(expect.arrayContaining([{ rev: 3, bpm: 188 }, { rev: 10, bpm: 180 }]))
    expect(screen.getAllByRole('button', { name: 'Deshacer' })).toHaveLength(1)
    vi.useFakeTimers()
    await act(() => vi.advanceTimersByTimeAsync(31_000))
    expect(screen.getByText('BPM duplicado en 2 canciones')).toBeInTheDocument()
    rendered.unmount() // Navigation does not discard the captured Undo.
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }))
    await waitFor(() => screen.getByText('BPM restaurado en 2 canciones'))
    expect(puts().slice(2).map(r => r.body)).toEqual(expect.arrayContaining([{ rev: 4, bpm: null }, { rev: 11, bpm: 90 }]))
    expect(views.get('Album/auto.flac')!.fixed.bpm).toBeNull()
    expect(views.get('Album/fixed.flac')!.fixed.bpm).toBe(90)
  })

  it('reloads and counts an Undo conflict without overwriting the newer value', async () => {
    const { views, puts, gets } = setup([song()])
    fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: `${double} · 94 → 188` })))
    await waitFor(() => screen.getByText('BPM duplicado en 1 canción'))
    views.get('Album/song.flac')!.rev = 20
    fireEvent.click(screen.getByRole('button', { name: 'Deshacer' }))
    await waitFor(() => screen.getByText('BPM restaurado en 0 canciones · 1 omitidas'))
    expect(puts()).toHaveLength(2)
    expect(gets('Album/song.flac')).toHaveLength(2)
    expect(views.get('Album/song.flac')!.fixed.bpm).toBe(188)
  })

  it('skips a stale preview discovered while fetching a missing listing revision', async () => {
    const { views, puts } = setup([song()])
    views.get('Album/song.flac')!.bpm.value = 100
    fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: `${double} · 94 → 188` })))
    await waitFor(() => screen.getByText('Duplicadas 0 · 1 omitidas'))
    expect(puts()).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Deshacer' })).toBeNull()
  })

  it('counts failed saves without stopping the remaining songs', async () => {
    const { puts } = setup([song(94, 'a'), song(100, 'b')], { failures: ['a'] })
    fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: `${double} · 2 canciones` })))
    await waitFor(() => screen.getByText('Duplicadas 1 · 1 omitidas'))
    expect(puts()).toHaveLength(2)
  })

  it('deduplicates songs and limits GET/PUT work to four in flight', async () => {
    const songs = Array.from({ length: 10 }, (_, i) => song(94, `Album/${i}.flac`))
    const { releases, peak, puts } = setup([...songs, songs[0]], { delay: true })
    fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: `${double} · 10 canciones` })))
    await waitFor(() => expect(releases.length).toBe(4))
    for (let i = 0; i < 20; i++) {
      await waitFor(() => expect(releases.length).toBeGreaterThan(0))
      await act(async () => { releases.shift()!() })
    }
    await waitFor(() => screen.getByText('BPM duplicado en 10 canciones'))
    expect(puts()).toHaveLength(10)
    expect(peak()).toBe(4)
    vi.restoreAllMocks()
  })

  it('ships hand-written English labels, counts and toast lines', async () => {
    const catalog = JSON.parse(readFileSync(resolve(__dirname, '../../../locales/en/translation.json'), 'utf8'))
    expect(catalog["Double BPM"]).toBe('Double BPM')
    expect(catalog["Halve BPM"]).toBe('Halve BPM')
    await i18n.changeLanguage('en')
    const songs = Array.from({ length: 20 }, (_, i) => song(94, String(i)))
    const { rendered, client } = setup(songs)
    rendered.rerender(<QueryClientProvider client={client}><Harness songs={[songs[0]]} /></QueryClientProvider>)
    expect(await waitFor(() => screen.getByRole('menuitem', { name: 'Double BPM · 94 → 188' }))).toBeInTheDocument()
    rendered.rerender(<QueryClientProvider client={client}><Harness songs={songs} /></QueryClientProvider>)
    fireEvent.click(await waitFor(() => screen.getByRole('menuitem', { name: 'Double BPM · 20 songs' })))
    await waitFor(() => screen.getByText('BPM doubled for 20 songs'))
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })
})
