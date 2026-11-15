import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const posts = vi.hoisted(() => [] as Array<{ path: string; body: unknown }>)
vi.mock('../data', () => ({
  apiPost: vi.fn(async (path: string, init: { body?: unknown }) => {
    posts.push({ path, body: init?.body })
    if (path.endsWith('/resolve')) return { progress_id: `resolve-${posts.length}` }
    if (path.endsWith('/import')) return { progress_id: `import-${posts.length}` }
    return {}
  }),
  apiGet: vi.fn(async () => ({
    status: 'done',
    total: 1,
    results: { strong: [{ confidence: 'strong', wanted: { title: 'A' }, match: { title: 'A', artist: 'X', album: 'Album', durationSeconds: 180, coverUrl: 'https://images.example/cover.jpg', provider: 'deezer', providerId: '123', isrc: 'USAAA2600001', recordingMbid: 'recording-id' } }], review: [], rejected: [] },
  })),
}))

class FakeSource {
  static all: FakeSource[] = []
  url: string
  closed = false
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeSource.all.push(this)
  }
  addEventListener() {}
  close() {
    this.closed = true
  }
  emit(snapshot: object) {
    this.onmessage?.({ data: JSON.stringify(snapshot) })
  }
  static for(id: string) {
    return FakeSource.all.filter((s) => s.url.includes(id) && !s.closed).at(-1)!
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('Spotify import, several playlists', () => {
  beforeEach(() => {
    FakeSource.all = []
    posts.length = 0
    vi.stubGlobal('EventSource', FakeSource)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      playlists: [
        { name: 'One', trackCount: 1, tracks: [{ title: 'A', artist: 'X' }] },
        { name: 'Two', trackCount: 1, tracks: [{ title: 'B', artist: 'Y' }] },
      ],
    }), { status: 200 })))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keeps counting a download after moving on to the next playlist, and shows both at the end', async () => {
    const store = await import('./spotifyImportStore')
    store.reset()
    await store.parseExport(new File(['zip'], 'my_spotify_data.zip'))
    store.setAllPlaylists(true)
    store.startResolve()
    await tick()

    // Playlist 1: resolve → review → download, then move on while it downloads.
    FakeSource.for('resolve-1').emit({ total: 1, completed: 1, terminal: true, status: 'done' })
    await tick()
    expect(store.getState().step).toBe('review')
    const changed = vi.fn()
    window.addEventListener('playlists-changed', changed)
    expect(changed).not.toHaveBeenCalled()
    await store.startImport()
    expect(changed).toHaveBeenCalledTimes(1)
    window.removeEventListener('playlists-changed', changed)
    const firstDownload = posts.find((p) => p.path.endsWith('/import'))
    expect(firstDownload).toBeTruthy()
    expect(firstDownload?.body).toEqual({ playlistName: 'One', tracks: [{
      title: 'A', artist: 'X', album: 'Album', durationSeconds: 180,
      coverUrl: 'https://images.example/cover.jpg', provider: 'deezer', providerId: '123',
      isrc: 'USAAA2600001', mbid: 'recording-id',
    }] })
    FakeSource.for('import-').emit({ total: 1, completed: 0, done: [], status: 'in_progress' })
    store.skipPlaylist()
    await tick()
    expect(store.getState().summaries[0]).toMatchObject({ name: 'One', kind: 'downloading', accepted: 1 })

    // The first download finishes while playlist 2 is on screen.
    const firstId = store.getState().summaries[0].id
    FakeSource.for(firstId).emit({ total: 1, completed: 1, done: ['A'], terminal: true, status: 'Downloaded 1/1 tracks' })
    expect(store.getState().summaries[0]).toMatchObject({ kind: 'downloaded', downloaded: 1 })
    expect(store.getState().step).not.toBe('summary')

    // Playlist 2 downloads and finishes: the summary lists both.
    const resolveTwo = FakeSource.all.find((s) => s.url.includes('resolve-') && !s.closed)!
    resolveTwo.emit({ total: 1, completed: 1, terminal: true, status: 'done' })
    await tick()
    await store.startImport()
    const secondId = store.getState().summaries[1].id
    FakeSource.for(secondId).emit({ total: 1, completed: 1, done: ['B'], terminal: true, status: 'Downloaded 1/1 tracks' })
    const state = store.getState()
    expect(state.step).toBe('summary')
    expect(state.summaries.map((s: { name: string; kind: string }) => [s.name, s.kind])).toEqual([['One', 'downloaded'], ['Two', 'downloaded']])
  })
})
