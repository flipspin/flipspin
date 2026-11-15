import React from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AudioPlayerProvider, useAudioPlayer } from '../../state/AudioPlayerContext'
import { playbackEngine as engine } from './PlaybackEngine'
import { stemPlayer } from '../../stems/StemPlayer'
import { fetchStems, getManifest } from '../../stems/stemApi'
import { deferred, flush } from '../../stems/fakeAudio'
import { log } from '../../lib/log'
import { notify } from '../../ui/notifications'

vi.mock('../../ui/notifications', async original => ({ ...await original<typeof import('../../ui/notifications')>(), notify: vi.fn() }))

const context = vi.hoisted(() => ({
  state: 'running', sampleRate: 44100,
  resume: vi.fn(async () => { context.state = 'running' }),
  decodeAudioData: vi.fn(), audioWorklet: { addModule: async () => {} },
}))
vi.mock('../../stems/audioGraph', () => ({ getAudioGraph: () => ({ context, analyser: {} }), setGraphVolume: vi.fn(), setLevellingGain: vi.fn() }))
vi.mock('./nowPlayingAnchor', () => ({ NowPlayingAnchor: class { play() {} pause() {} dispose() {} } }))
vi.mock('../useReplayGain', () => ({ useReplayGain: () => ({ gain: null, pending: false }) }))
vi.mock('../../stems/background', () => ({ createBackgroundPreSplit: () => ({ schedule: vi.fn(), cancel: vi.fn() }) }))
vi.mock('../../stems/stemApi', async original => ({
  ...await original<typeof import('../../stems/stemApi')>(),
  probeBytes: vi.fn(async () => new ArrayBuffer(1)),
  getManifest: vi.fn(), fetchStems: vi.fn(),
}))
interface Message { type: string; generation: number; id: number; channels?: Float32Array[] }
interface Processor {
  port: { onmessage: (event: { data: object }) => void; postMessage: (data: object) => void }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
}
let ProcessorClass: new () => Processor
// Deliver port messages asynchronously, as the real worker/worklet do. Keep a
// failed processor dead across resets: browsers never call process again.
class Output {
  static instance: Output
  processor = new ProcessorClass()
  dead = false
  crash?: unknown
  messages: Message[] = []
  onprocessorerror?: () => void
  port = {
    onmessage: undefined as ((event: { data: object }) => void) | undefined,
    postMessage: (data: Message) => {
      const message = structuredClone(data)
      this.messages.push(message)
      queueMicrotask(() => {
        if (this.dead) return
        try { this.processor.port.onmessage({ data: message }) }
        catch (error) { this.crash = error; this.dead = true; this.onprocessorerror?.() }
      })
    },
    close: vi.fn(),
  }
  connect = vi.fn()
  disconnect = vi.fn()
  constructor() {
    Output.instance = this
    this.processor.port.postMessage = data => queueMicrotask(() => this.port.onmessage?.({ data }))
  }
  render(frames = 128) {
    const channels = [new Float32Array(frames), new Float32Array(frames)]
    if (!this.dead && context.state === 'running') {
      try { this.processor.process([], [channels]) }
      catch (error) { this.crash = error; this.dead = true; this.onprocessorerror?.() }
    }
    return channels[0]
  }
}
class Decoder {
  static instance: Decoder
  starts: { src: string; id: number; token: number }[] = []
  private job?: { id: number; token: number; remaining: number }
  onmessage?: (event: { data: object }) => void
  constructor() { Decoder.instance = this }
  postMessage = (m: { type: string; token: number; id: number; src: string; seconds: number }) => {
    if (m.type === 'cancel') this.job = undefined
    if (m.type === 'start') {
      this.starts.push(m)
      this.job = { ...m, remaining: Math.round((60 - m.seconds) * 44100) }
    }
    const job = this.job
    queueMicrotask(() => {
      if (!job || this.job !== job) return
      if (m.type === 'start') this.onmessage?.({ data: { ...m, type: 'metadata', rate: 44100, info: { sampleRate: 44100, duration: 60 } } })
      if (m.type !== 'pull') return
      const frames = Math.min(44100, job.remaining)
      job.remaining -= frames
      if (frames) this.onmessage?.({ data: { ...m, type: 'pcm', rate: 44100, channels: [new Float32Array(frames).fill(.25), new Float32Array(frames).fill(.25)] } })
      this.onmessage?.({ data: { ...m, type: job.remaining ? 'pulled' : 'done' } })
    })
  }
  terminate = vi.fn()
}
const tracks = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].map(name => ({ path: `Album/${name}.mp3`, relPath: `Album/${name}.mp3`, title: name }))
const wrapper = ({ children }: { children: React.ReactNode }) => <AudioPlayerProvider>{children}</AudioPlayerProvider>
const buffer = () => ({ duration: 60, sampleRate: 44100, length: 60 * 44100, numberOfChannels: 2,
  getChannelData: () => new Float32Array(60 * 44100).fill(.125), copyFromChannel: vi.fn(), copyToChannel: vi.fn() })
const settleDecodes: (() => void)[] = []
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules(); localStorage.clear()
  vi.mocked(notify).mockClear()
  vi.stubGlobal('sampleRate', 44100); vi.stubGlobal('currentFrame', 0)
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: () => {}, postMessage: () => {} } })
  vi.stubGlobal('registerProcessor', (_name: string, Constructor: new () => Processor) => { ProcessorClass = Constructor })
  await import('./output.worklet')
  vi.stubGlobal('AudioWorkletNode', Output); vi.stubGlobal('Worker', Decoder)
  context.state = 'running'; context.decodeAudioData.mockReset().mockImplementation(async () => buffer())
  vi.mocked(getManifest).mockReset().mockResolvedValue({ track: { duration: 60 }, stems: { drums: '', bass: '', other: '', vocals: '' } })
  vi.mocked(fetchStems).mockReset().mockResolvedValue(Array.from({ length: 4 }, () => new ArrayBuffer(4)))
  stemPlayer.setCarryMix(false); stemPlayer.reset(); await stemPlayer.activate()
})
afterEach(async () => {
  cleanup(); stemPlayer.detach(); engine.dispose()
  settleDecodes.splice(0).forEach(settle => settle()); await flush()
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})
async function start() {
  const hook = renderHook(useAudioPlayer, { wrapper })
  await act(async () => { hook.result.current.setQueueWithTracks(tracks); await flush() })
  await audible(hook.result)
  return hook
}
async function audible(result: { current: ReturnType<typeof useAudioPlayer> }) {
  let samples!: Float32Array
  await act(async () => { samples = Output.instance.render(); await flush() })
  expect(Output.instance.crash).toBeUndefined()
  expect(Output.instance.dead).toBe(false)
  expect(context.state).toBe('running')
  expect(samples.some(sample => sample > 0)).toBe(true)
  expect(engine.paused).toBe(false)
  expect(result.current.playerState).toBe('playing')
  const latest = Output.instance.messages.filter(m => m.type === 'track').at(-1)!
  expect(Output.instance.messages.some(m => m.type === 'pcm' && m.generation === latest.generation && m.id === latest.id && m.channels?.[0].length)).toBe(true)
}
async function solo() {
  await act(async () => {
    const levels = Output.instance.messages.filter(m => m.type === 'levels').length
    stemPlayer.toggleSolo('bass')
    expect(Output.instance.messages.filter(m => m.type === 'levels')).toHaveLength(levels)
    // Render the original while its replacement is fetching/decoding.
    Output.instance.render()
    await flush()
  })
  expect(stemPlayer.getSnapshot().state).toBe('stems')
}
async function changeLoaded(control: 'fader' | 'mute' | 'solo') {
  await act(async () => { stemPlayer.setLevel('vocals', 80); await flush() })
  expect(stemPlayer.getSnapshot().state).toBe('stems')
  await act(async () => {
    if (control === 'fader') stemPlayer.setLevel('bass', 45)
    if (control === 'mute') stemPlayer.toggleMute('other')
    if (control === 'solo') stemPlayer.toggleSolo('vocals')
    await flush()
  })
  expect(stemPlayer.getSnapshot().state).toBe('stems')
}
async function originalPlays(result: { current: ReturnType<typeof useAudioPlayer> }) {
  expect(stemPlayer.getSnapshot().state).toBe('original')
  const messages = Output.instance.messages.filter(m => m.type === 'levels').length
  await act(async () => { stemPlayer.previewLevel('bass', 20); await flush() })
  expect(Output.instance.messages.filter(m => m.type === 'levels')).toHaveLength(messages)
  await audible(result)
}
// Runs real mixer/worklet processing across stems and three subsequent source handoffs.
it.each(['fader', 'mute', 'solo'] as const)('plays three Nexts after changing %s on loaded stems', async control => {
  const { result } = await start(); await changeLoaded(control); await audible(result)
  for (let index = 1; index <= 3; index++) {
    await act(async () => { result.current.goNext(); await flush() })
    expect(result.current.nowPlaying).toEqual(tracks[index])
    await originalPlays(result)
  }
  expect(notify).not.toHaveBeenCalled()
}, 20000)
// Processes the real mixer through a previous-track transition and three Nexts.
it.each(['fader', 'mute', 'solo'] as const)('plays after %s then Prev and three Nexts', async control => {
  const { result } = await start()
  await act(async () => { result.current.goNext(); await flush() })
  await changeLoaded(control); await audible(result)
  await act(async () => { result.current.goPrevious(); await flush() })
  expect(result.current.nowPlaying).toEqual(tracks[0]); await originalPlays(result)
  for (let index = 1; index <= 3; index++) {
    await act(async () => { result.current.goNext(); await flush() })
    expect(result.current.nowPlaying).toEqual(tracks[index]); await originalPlays(result)
  }
  expect(notify).not.toHaveBeenCalled()
}, 20000)
// Processes audio through natural completion and three subsequent source handoffs.
it.each(['fader', 'mute', 'solo'] as const)('plays after %s then natural end and three Nexts', async control => {
  const { result } = await start(); await changeLoaded(control); await audible(result)
  await act(async () => {
    engine.currentTime = 60 - 128 / 44100; await flush()
    Output.instance.render(256); await flush()
  })
  expect(result.current.nowPlaying).toEqual(tracks[1]); await originalPlays(result)
  for (let index = 2; index <= 4; index++) {
    await act(async () => { result.current.goNext(); await flush() })
    expect(result.current.nowPlaying).toEqual(tracks[index]); await originalPlays(result)
  }
  expect(notify).not.toHaveBeenCalled()
}, 20000)
// Loads and processes stems through the real mixer before verifying the transport handoff.
it.each(['media-next', 'media-previous', 'queue'] as const)('releases loaded stems on %s', async action => {
  const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>()
  vi.stubGlobal('navigator', { mediaSession: { setActionHandler: (key: MediaSessionAction, fn: MediaSessionActionHandler | null) => handlers.set(key, fn) } })
  const { result } = await start()
  await act(async () => { result.current.goNext(); await flush() })
  await changeLoaded('fader'); await audible(result)
  await act(async () => {
    if (action === 'queue') result.current.playQueueItemAt(1)
    else handlers.get(action === 'media-next' ? 'nexttrack' : 'previoustrack')!({ action: action === 'media-next' ? 'nexttrack' : 'previoustrack' })
    await flush()
  })
  expect(result.current.nowPlaying).toEqual(tracks[action === 'queue' ? 3 : action === 'media-next' ? 2 : 0])
  await originalPlays(result)
  for (let count = 0; count < 3; count++) {
    await act(async () => { result.current.goNext(); await flush() })
    await originalPlays(result)
  }
  expect(notify).not.toHaveBeenCalled()
}, 20000)
// Runs stems output, prefetch and original-source decoding through the real worklet harness.
it.each(['next', 'ended'] as const)('prefetches the next original head during stems playback, then %s plays', async action => {
  const { result } = await start(); await changeLoaded('fader')
  await act(async () => { engine.currentTime = 50; await flush() })
  await audible(result)
  expect(Decoder.instance.starts.at(-1)?.src).toContain('two.mp3')
  const next = Output.instance.messages.filter(m => m.type === 'track').at(-1)!
  expect(Output.instance.messages.some(m => m.type === 'pcm' && m.id === next.id && m.channels?.[0].length)).toBe(true)
  await act(async () => {
    if (action === 'next') result.current.goNext()
    else Output.instance.render(10 * 44100 + 128)
    await flush()
  })
  expect(result.current.nowPlaying).toEqual(tracks[1]); await audible(result)
  // A late mixer preview must never address the promoted original ring.
  const levels = Output.instance.messages.filter(m => m.type === 'levels').length
  await act(async () => { stemPlayer.previewLevel('bass', 20); await flush() })
  expect(Output.instance.messages.filter(m => m.type === 'levels')).toHaveLength(levels)
  for (let index = 2; index <= 4; index++) {
    await act(async () => { result.current.goNext(); await flush() })
    expect(result.current.nowPlaying).toEqual(tracks[index]); await audible(result)
  }
  expect(notify).not.toHaveBeenCalled()
}, 20000)
it.each(['selection', 'next', 'original'] as const)('plays after solo/loading stems then %s', async action => {
  const { result } = await start(); await solo()
  await act(async () => {
    if (action === 'selection') result.current.play(tracks[2])
    if (action === 'next') result.current.goNext()
    if (action === 'original') stemPlayer.reset()
    await flush()
  })
  expect(engine.src).toContain(action === 'selection' ? 'three.mp3' : action === 'next' ? 'two.mp3' : 'one.mp3')
  await audible(result)
})
it.each(['original', 'selection'] as const)('resumes a suspended context on %s handoff', async action => {
  const { result } = await start(); await solo()
  context.state = 'suspended'
  await act(async () => {
    if (action === 'original') stemPlayer.reset()
    else result.current.play(tracks[1])
    await flush()
  })
  await audible(result)
})
it.each(['fetch', 'decode'] as const)('times out a never resolving %s, keeps original and later selections playing', async stage => {
  const { result } = await start()
  engine.currentTime = 2; await act(async () => { await flush() })
  if (stage === 'fetch') vi.mocked(fetchStems).mockReturnValueOnce(new Promise(() => {}))
  else {
    const pending = deferred<AudioBuffer>()
    context.decodeAudioData.mockReturnValue(pending.promise)
    settleDecodes.push(() => pending.resolve(buffer()))
  }
  await act(async () => { stemPlayer.toggleSolo('bass'); await flush() })
  expect(stemPlayer.getSnapshot().state).toBe('loading')
  await act(async () => { await vi.advanceTimersByTimeAsync(20000); await flush() })
  expect(stemPlayer.getSnapshot()).toMatchObject({ state: 'error', reason: expect.stringMatching(/timed out/i) })
  expect(engine.currentTime).toBe(2)
  expect(vi.mocked(fetchStems).mock.calls.at(-1)![1].aborted).toBe(true)
  await audible(result)
  await act(async () => { result.current.goNext(); await flush() })
  expect(engine.src).toContain('two.mp3'); await audible(result)
})
it('ignores an obsolete load after selection and Original, including a late rejection', async () => {
  const { result } = await start()
  const pending = deferred<ArrayBuffer[]>()
  vi.mocked(fetchStems).mockReturnValueOnce(pending.promise)
  await act(async () => { stemPlayer.toggleSolo('bass'); await flush() })
  await act(async () => { result.current.goNext(); await flush(); pending.reject(new Error('obsolete')); await flush() })
  expect(stemPlayer.getSnapshot().state).toBe('original'); await audible(result)
})
it('solo and mute change levels without changing transport or the output generation', async () => {
  const { result } = await start(); await solo(); await audible(result)
  const resets = Output.instance.messages.filter(m => m.type === 'reset').length
  await act(async () => { stemPlayer.toggleMute('other'); stemPlayer.toggleSolo('vocals'); await flush() })
  await audible(result)
  act(() => result.current.setIsPlaying(false))
  await act(async () => { stemPlayer.toggleMute('drums'); stemPlayer.toggleSolo('vocals'); await flush() })
  expect(engine.paused).toBe(true); expect(result.current.playerState).toBe('paused')
  expect(Output.instance.messages.filter(m => m.type === 'reset')).toHaveLength(resets)
})
it.each(['fetch', 'decode'] as const)('a %s failure stays in stems and original playback survives at the same position', async stage => {
  const { result } = await start()
  engine.currentTime = 2; await act(async () => { await flush() })
  if (stage === 'fetch') vi.mocked(fetchStems).mockRejectedValueOnce(new Error('Stem unavailable'))
  else context.decodeAudioData.mockRejectedValueOnce(new Error('Stem unavailable'))
  await act(async () => { stemPlayer.toggleSolo('bass'); await flush() })
  expect(stemPlayer.getSnapshot()).toMatchObject({ state: 'error', reason: 'Stem unavailable' })
  expect(engine.error).toBeNull(); expect(engine.currentTime).toBe(2)
  await audible(result)
  for (let index = 1; index <= 3; index++) {
    await act(async () => { result.current.goNext(); await flush() })
    expect(result.current.nowPlaying).toEqual(tracks[index]); await originalPlays(result)
  }
  expect(notify).not.toHaveBeenCalled()
})
it('logs each ownership direction with its reason', async () => {
  const debug = vi.spyOn(log.playback, 'debug')
  await start(); await solo()
  await act(async () => { stemPlayer.reset(); await flush() })
  expect(debug.mock.calls.filter(([message]) => message === 'output ownership changed')).toEqual([
    ['output ownership changed', { from: 'engine', to: 'stems', reason: 'stems-ready' }],
    ['output ownership changed', { from: 'stems', to: 'engine', reason: 'original' }],
  ])
})
it('late stems cleanup does not reset an already playing plain source', async () => {
  await start(); await solo()
  engine.src = 'plain.mp3'; engine.load(); await flush(); await engine.play()
  const resets = Output.instance.messages.filter(m => m.type === 'reset').length
  stemPlayer.setTrack(null); await flush()
  expect(Output.instance.messages.filter(m => m.type === 'reset')).toHaveLength(resets)
  expect(Output.instance.render().some(value => value > 0)).toBe(true)
  expect(engine.paused).toBe(false)
})
