import { stemPlayer } from './StemPlayer';
import { playbackEngine } from '../player/engine/PlaybackEngine';
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioPlayerProvider, useAudioPlayer } from '@state/AudioPlayerContext'
import { installFakeSettings, type FakeSettings, type RecordedRequest, type ResponseSpec } from '../settings/test-support'
import { createBackgroundPreSplit } from './background'

const track = (file: string) => ({ path: `/music/Album/${file}.mp3` })
const row = (file: string, stale = false) => ({ album: 'Album', file: `${file}.mp3`, title: file, artist: '', albumTitle: 'Album', createdAt: null, stale })
const original = { levels: { drums: 100, bass: 100, other: 100, vocals: 100 }, muted: [], solo: [] }
const mixed = { ...original, levels: { ...original.levels, vocals: 20 } }
let fake: FakeSettings
let scheduler: ReturnType<typeof createBackgroundPreSplit>
let enabled: boolean
let ready: ReturnType<typeof row>[]
const requests = () => fake.requests.filter(r => r.method === 'POST')
const advance = async (ms = 2000) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

function install(respond?: (r: RecordedRequest) => ResponseSpec | undefined) {
  fake = installFakeSettings({ respond: r => {
    const custom = respond?.(r)
    if (custom) return custom
    if (r.pathname === '/api/server/config') return { status: 200, json: { groups: [{ settings: [{ key: 'KROBI_STEMS_BACKGROUND', value: enabled }] }] } }
    if (r.pathname === '/api/stems') return { status: 200, json: { splits: ready } }
    if (r.pathname === '/api/stems/request') return { status: 200, json: { status: 'queued' } }
  } })
}
beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  localStorage.setItem('krobi.mix', JSON.stringify(mixed))
  enabled = true
  ready = [row('current'), row('ready')]
  install()
  scheduler = createBackgroundPreSplit()
})
afterEach(() => { scheduler.cancel(); fake.restore(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('check 10: background pre-split', () => {
  it('waits 2 s, skips ready/current/duplicate songs and sends at most two in queue order', async () => {
    scheduler.schedule(track('current'), ['ready', 'one', 'one', 'current', 'two', 'three'].map(track))
    await advance(1999)
    expect(fake.requests).toHaveLength(0)
    await advance(1)
    expect(requests().map(r => r.body)).toEqual([
      { album: 'Album', file: 'one.mp3', priority: 'background' },
      { album: 'Album', file: 'two.mp3', priority: 'background' },
    ])
  })
  it('sends no requests when the switch is off', async () => {
    enabled = false
    scheduler.schedule(track('current'), ['one', 'two'].map(track))
    await advance()
    expect(requests()).toHaveLength(0)
    expect(fake.requests.some(r => r.pathname === '/api/stems')).toBe(false)
  })
  // A partial mix is read the way the stem player reads it (mix.ts: missing levels = 100),
  // so `{levels:{vocals:20}}` is a real mix and is not listed here.
  it.each([original, null, {}, { ...original, solo: null }])('sends nothing for Original, absent or malformed mix %j', async mix => {
    localStorage.setItem('krobi.mix', JSON.stringify(mix))
    scheduler.schedule(track('current'), [track('one')])
    await advance()
    expect(fake.requests).toHaveLength(0)
  })
  it.each([{ ...original, muted: ['drums'] }, { ...original, solo: ['vocals'] }])('recognizes mute and solo as a non-Original mix %j', async mix => {
    localStorage.setItem('krobi.mix', JSON.stringify(mix))
    scheduler.schedule(track('current'), [track('one')])
    await advance()
    expect(requests()).toHaveLength(1)
  })
  it('does nothing for a stopped player or an unsplit/stale current song', async () => {
    scheduler.schedule(track('current'), [track('one')], false)
    await advance()
    expect(fake.requests).toHaveLength(0)
    ready = [row('current', true)]
    scheduler.schedule(track('current'), [track('one')])
    await advance()
    expect(requests()).toHaveLength(0)
    ready = []
    scheduler.schedule(track('current'), [track('one')])
    await advance()
    expect(requests()).toHaveLength(0)
  })
  it('treats a stale upcoming split as needing a new split', async () => {
    ready.push(row('stale', true))
    scheduler.schedule(track('current'), [track('stale')])
    await advance()
    expect(requests()[0].body).toEqual({ album: 'Album', file: 'stale.mp3', priority: 'background' })
  })
  it('debounces rapid track/queue edits and uses only the latest queue', async () => {
    scheduler.schedule(track('current'), [track('old')])
    await advance(1500)
    ready.push(row('new-current'))
    scheduler.schedule(track('new-current'), ['new-one', 'new-two', 'three'].map(track))
    await advance(1999)
    expect(requests()).toHaveLength(0)
    await advance(1)
    expect(requests().map(r => (r.body as { file: string }).file)).toEqual(['new-one.mp3', 'new-two.mp3'])
  })
  it('reads the mix at dispatch and cancels if the user returns to Original', async () => {
    scheduler.schedule(track('current'), [track('one')])
    localStorage.setItem('krobi.mix', JSON.stringify(original))
    await advance()
    expect(fake.requests).toHaveLength(0)
  })
  it('cancel/disposal prevents scheduled work', async () => {
    scheduler.schedule(track('current'), [track('one')])
    scheduler.cancel()
    await advance(5000)
    expect(fake.requests).toHaveLength(0)
  })
  it('stops after skipped and quietly absorbs background failures', async () => {
    fake.restore()
    install(r => r.pathname === '/api/stems/request' ? { status: 200, json: { status: 'skipped' } } : undefined)
    scheduler.schedule(track('current'), ['one', 'two'].map(track))
    await advance()
    expect(requests()).toHaveLength(1)
    fake.restore()
    install(r => r.pathname === '/api/stems/request' ? { status: 503, json: { detail: 'offline' } } : undefined)
    scheduler.schedule(track('current'), ['one', 'two'].map(track))
    await advance()
    expect(requests()).toHaveLength(1)
  })
  it('lets members pre-split when config is forbidden, with server-scoped requests', async () => {
    fake.restore()
    install(r => r.pathname === '/api/server/config' ? { status: 403, json: { detail: 'owner-only' } } : undefined)
    scheduler.schedule(track('current'), ['one', 'two', 'three'].map(track))
    await advance()
    expect(requests().map(r => r.body)).toEqual([
      { album: 'Album', file: 'one.mp3', priority: 'background' },
      { album: 'Album', file: 'two.mp3', priority: 'background' },
    ])
  })
  it('a member cannot read the switch: one skipped probe stops when the server has it off', async () => {
    fake.restore()
    install(r => r.pathname === '/api/server/config' ? { status: 403, json: { detail: 'owner-only' } } : r.pathname === '/api/stems/request' ? { status: 200, json: { status: 'skipped' } } : undefined)
    scheduler.schedule(track('current'), ['one', 'two'].map(track))
    await advance()
    expect(requests()).toHaveLength(1)
  })
  it.each([401, 500])('does not pre-split when the config read fails with %s', async status => {
    fake.restore()
    install(r => r.pathname === '/api/server/config' ? { status, json: { detail: 'unavailable' } } : undefined)
    scheduler.schedule(track('current'), [track('one')])
    await advance()
    expect(requests()).toHaveLength(0)
  })
  it('does not post a stale queue after an in-flight setting read finishes', async () => {
    let resolve!: (value: boolean) => void
    scheduler = createBackgroundPreSplit({ readEnabled: () => new Promise<boolean>(done => { resolve = done }) })
    scheduler.schedule(track('current'), [track('old')])
    await advance()
    scheduler.schedule(track('current'), [track('new')])
    resolve(true)
    await advance(1)
    expect(requests()).toHaveLength(0)
  })
  it('AudioPlayerContext wires track changes and queue edits, without a settings page or owner gate', async () => {
    stemPlayer.setCarryMix(true)
    vi.spyOn(playbackEngine, 'load').mockImplementation(() => {})
    const { result, unmount } = renderHook(() => useAudioPlayer(), { wrapper: AudioPlayerProvider })
    act(() => result.current.play(track('current'), { replaceQueue: true, upcomingTracks: ['one', 'two', 'three'].map(track) }))
    await advance()
    expect(requests()).toHaveLength(2)
    ready.push(row('one'))
    act(() => result.current.goNext())
    await advance()
    expect(requests()).toHaveLength(4)
    act(() => result.current.addNextInQueue(track('inserted')))
    await advance(1000)
    act(() => result.current.removeFromQueue(1))
    await advance(1999)
    expect(requests()).toHaveLength(4)
    await advance(1)
    expect(requests().slice(4).map(r => (r.body as { file: string }).file)).toEqual(['inserted.mp3', 'three.mp3'])
    unmount()
    stemPlayer.setCarryMix(false)
  })
})
