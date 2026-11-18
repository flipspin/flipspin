import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PlaybackController } from '../player/PlaybackController'
import { fakeAudio } from '../player/fakeAudio'
import { StemPlayer } from './StemPlayer'
import { FakeContext, flush } from './fakeAudio'
import { originalMix, STEMS } from './mix'
import type { Manifest } from './stemApi'

const disposers: (() => void)[] = []
beforeEach(() => { vi.useFakeTimers(); localStorage.clear() })
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.useRealTimers() })

describe('stems failures are separate from unplayable original tracks', () => {
  it.each(['fetch', 'decode', 'solo-load', 'solo'] as const)('%s does not spend or reset two automatic failures', async failure => {
    const audio = fakeAudio()
    const host = Object.assign(audio.element, { setStemSource: vi.fn(), setStemLevels: vi.fn() })
    const notice = vi.fn(), fetcher = vi.fn<typeof fetch>()
    let index = 0
    const select = () => controller.select({ key: String(index), src: `https://media.example/${index}`, origin: 'https://media.example', title: String(index) })
    const controller = new PlaybackController({ notice, fetcher, advance: () => { index++; select() } })
    disposers.push(controller.attach(host))
    controller.setIntent(true); select()
    audio.error(4, 200); await flush(); audio.error(4, 200); await flush()

    const context = new FakeContext()
    const manifest: Manifest = { track: { duration: 180 }, stems: Object.fromEntries(STEMS.map(stem => [stem, `/api/stems/album/song/${stem}`])) as Manifest['stems'] }
    const fetchStems = vi.fn(async () => STEMS.map(() => new ArrayBuffer(4)))
    const stems = new StemPlayer({ graph: () => context.graph(), host, probe: async () => new ArrayBuffer(1), manifest: async () => manifest, fetch: fetchStems }, originalMix())
    disposers.push(() => stems.detach())
    stems.setTrack({ album: 'album', file: 'song.mp3' }); await stems.activate()
    if (failure === 'fetch' || failure === 'solo-load') fetchStems.mockRejectedValueOnce(new Error('stem: HTTP 404'))
    if (failure === 'decode') context.decodeAudioData.mockRejectedValueOnce(new Error('stem decode failed'))
    if (failure === 'solo' || failure === 'solo-load') stems.toggleSolo('vocals')
    else stems.setPreset('karaoke')
    await flush()
    expect(stems.getSnapshot().state).toBe(failure === 'solo' ? 'stems' : 'error')
    if (failure === 'solo') {
      stems.toggleSolo('drums'); await flush()
      expect(host.setStemLevels).toHaveBeenLastCalledWith([1, 0, 0, 1])
    } else {
      expect(host.setStemSource).toHaveBeenLastCalledWith(null, 'stems-load-failed')
      expect(host.setStemSource.mock.calls.every(([source]) => source === null)).toBe(true)
    }
    expect(controller.getSnapshot()).toMatchObject({ state: 'loading', intent: true, cause: null })
    expect(audio.load).toHaveBeenCalledTimes(3)
    expect(notice.mock.calls.filter(([kind]) => kind === 'consecutive')).toHaveLength(0)
    expect(fetcher).not.toHaveBeenCalled()

    // The third original failure still stops: stems did not reset the budget either.
    audio.error(4, 200); await flush()
    expect(controller.getSnapshot()).toMatchObject({ state: 'paused', intent: false })
    expect(audio.load).toHaveBeenCalledTimes(3)
    expect(notice.mock.calls.filter(([kind]) => kind === 'consecutive')).toHaveLength(1)
  })
})
