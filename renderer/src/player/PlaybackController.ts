import type { PlaybackPort } from './engine/PlaybackPort'
import { log } from '../lib/log'
import { bridge, hasBridge } from '../bridge'
import { playerReducer, type FailureCause, type PlayerState } from './playerState'
import { clearPosition, persistPosition, readPosition, restoreSeconds, type SavedPosition } from './position'
interface PrefetchTrack { key: string; src: string; cached?: boolean }
import { trace } from './trace'
import { activityHold } from './activity'

export interface PlaybackTrack { key: string; src: string; title: string; origin: string }
export type PlayerNotice = 'gesture' | 'auth' | 'decode' | 'notSupported' | 'missing' | 'consecutive' | 'deleted' | 'empty'
interface Options {
  advance: () => void
  notice: (notice: PlayerNotice, title: string) => void
  missing?: (track: Pick<PlaybackTrack, 'key'>) => void
  fetcher?: typeof fetch
  storage?: Storage
}
export interface PlaybackSnapshot { state: PlayerState; cause: FailureCause | null; intent: boolean }
const BACKOFF = [1000, 2000, 4000, 8000, 15000]

/** One driver for the single engine. Async completions belong to a session + load. */
export class PlaybackController {
  private snapshot: PlaybackSnapshot = { state: 'idle', cause: null, intent: false }
  private activity = activityHold('Playing music')
  private listeners = new Set<() => void>()
  private engine?: PlaybackPort
  private track?: PlaybackTrack
  private session = 0
  private generation = 0
  private metadata = false
  private attempt = 0
  private authRetries = 0
  private decodeRetries = 0
  private skips = 0
  private skippedTracks = new Set<string>()
  private stopped = false
  private reloadOnPlay = false
  private lastPosition = 0
  private resume: number | null = null
  private savedPosition: SavedPosition | null = null
  private firstSelection = true
  private gestureNotified = false
  private pendingPlay = false
  private blocked = false
  private selectionPending = false
  private connected = true
  private probe?: AbortController
  private retryTimer?: ReturnType<typeof setTimeout>
  private retryScheduled = false
  private stallTimer?: ReturnType<typeof setTimeout>
  private waitLogTimer?: ReturnType<typeof setTimeout>
  private waitStarted?: number
  private mediaSource?: 'local' | 'server'
  private beginWait() {
    if (this.waitStarted !== undefined || !this.track || !this.snapshot.intent) return
    this.waitStarted = performance.now()
    const track = this.track, position = this.position(), started = this.waitStarted
    this.waitLogTimer = setTimeout(() => {
      this.waitLogTimer = undefined
      const waitMs = Math.round(performance.now() - started)
      void this.logStall(track, position, waitMs, this.mediaSource)
    }, 501)
  }
  private clearWait() {
    clearTimeout(this.waitLogTimer); this.waitLogTimer = undefined; this.waitStarted = undefined
  }
  private async logStall(track: PlaybackTrack, position: number, waitMs: number, known?: 'local' | 'server') {
    let source = known || (/^(file|blob):/.test(track.src) ? 'local' : 'server')
    if (!known && hasBridge()) {
      try {
        const status = await bridge().invoke('offline:status', { keys: [track.key] })
        if (status.tracks.some(row => row.verifiedAt !== null && ['descargado', 'desactualizado', 'ya no está en el nido'].includes(row.state))) source = 'local'
      } catch { /* A failed diagnostic lookup must not affect playback. */ }
    }
    log.playback.warn('playback stall', { song: track.key, source, position, waitMs })
  }
  private skipTimer?: ReturnType<typeof setTimeout>
  private remaining = 0
  private deadline = 0
  private cleanupPosition?: () => void
  private cleanups: (() => void)[] = []
  constructor(private options: Options) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.snapshot
  private publish(patch: Partial<PlaybackSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.activity(!!this.track && this.snapshot.intent && !this.stopped && !['ended', 'failed'].includes(this.snapshot.state))
    this.listeners.forEach(listener => listener())
  }
  private move(next: PlayerState) {
    const state = playerReducer(this.snapshot.state, next)
    if (state === this.snapshot.state) {
      log.playback.debug('ignored player transition', { from: state, to: next })
      return
    }
    if (state !== 'buffering') { clearTimeout(this.stallTimer); this.stallTimer = undefined }
    if (state !== 'loading' && state !== 'buffering') this.clearWait()
    this.publish({ state })
    if (state === 'loading' || state === 'buffering') this.beginWait()
  }
  attach(engine: PlaybackPort) {
    this.engine = engine
    const on = (name: string, fn: () => void) => {
      engine.addEventListener(name, fn)
      this.cleanups.push(() => engine.removeEventListener(name, fn))
    }
    const owned = () => !!this.track && !this.selectionPending
    on('loadstart', () => { if (owned()) this.move('loading') })
    on('loadedmetadata', () => {
      if (!owned()) return
      this.metadata = true
      if (this.savedPosition) {
        const seconds = restoreSeconds(this.savedPosition, engine.duration)
        this.savedPosition = null
        if (seconds !== null) engine.currentTime = seconds
      }
      if (this.resume !== null) {
        engine.currentTime = Math.max(0, Math.min(this.resume, engine.duration || this.resume))
        this.resume = null
      }
      if (!this.snapshot.intent) this.move('paused')
      this.drive()
    })
    on('canplay', () => {
      if (!owned()) return
      if (import.meta.env.KROBI_PLAYBACK_TRACE === '1') trace('canplay', this.session, this.track.key)
      this.drive()
    })
    const sourceListener = (event: Event) => {
      const detail = (event as CustomEvent<{ cacheHit?: boolean; src?: string }>).detail
      if (owned() && detail?.src === this.track?.src) this.mediaSource = detail.cacheHit || /^(file|blob):/.test(this.track.src) ? 'local' : 'server'
    }
    engine.addEventListener('firstByte', sourceListener)
    this.cleanups.push(() => engine.removeEventListener('firstByte', sourceListener))
    if (import.meta.env.KROBI_PLAYBACK_TRACE === '1') {
      for (const name of ['firstByte', 'boundary'] as const) {
        const listener = (event: Event) => { if (this.track) trace(name, this.session, this.track.key, (event as CustomEvent).detail) }
        engine.addEventListener(name, listener)
        this.cleanups.push(() => engine.removeEventListener(name, listener))
      }
      on('seeking', () => { if (this.track) trace('seeking', this.session, this.track.key) })
    }
    on('playing', () => {
      if (!owned() || this.selectionPending || !this.metadata || !this.snapshot.intent || this.retryTimer || this.probe) return
      this.move('playing')
      if (this.snapshot.state !== 'playing') return
      this.resetSkips()
      if (import.meta.env.KROBI_PLAYBACK_TRACE === '1') trace('playing', this.session, this.track.key)
    })
    on('waiting', () => {
      if (!owned() || this.snapshot.state !== 'playing') return
      this.move('buffering')
      if (import.meta.env.KROBI_PLAYBACK_TRACE === '1') trace('waiting', this.session, this.track.key)
    })
    on('stalled', () => {
      if (!owned()) return
      if (import.meta.env.KROBI_PLAYBACK_TRACE === '1') trace('stalled', this.session, this.track.key)
      if (this.snapshot.state === 'buffering' && !this.stallTimer) this.stallTimer = setTimeout(() => {
        this.stallTimer = undefined
        if (this.snapshot.state === 'buffering') void this.handleError(2)
      }, 10001)
    })
    on('pause', () => {
      if (!owned() || this.selectionPending || !this.metadata || this.probe || this.snapshot.state === 'retrying' || this.snapshot.state === 'failed' || engine.ended) return
      this.publish({ intent: false }); this.move('paused')
    })
    const missingListener = (event: Event) => {
      const detail = (event as CustomEvent<{ key: string }>).detail
      if (detail?.key) this.options.missing?.({ key: detail.key })
    }
    engine.addEventListener('trackMissing', missingListener)
    this.cleanups.push(() => engine.removeEventListener('trackMissing', missingListener))
    on('error', () => { if (owned()) void this.handleError(engine.error?.code || 2) })
    on('ended', () => {
      if (!this.track || this.stopped || this.selectionPending || this.snapshot.state === 'ended') return
      this.move('ended')
      if (this.getSnapshot().state !== 'ended') return
      this.cancelPending()
      if (import.meta.env.KROBI_PLAYBACK_TRACE === '1') trace('ended', this.session, this.track.key)
      this.options.advance()
    })
    on('seeked', () => {
      if (!this.track) return
      this.lastPosition = this.position()
      if (import.meta.env.KROBI_PLAYBACK_TRACE === '1') trace('seeked', this.session, this.track.key)
    })
    on('timeupdate', () => {
      if (!owned() || !this.metadata) return
      this.lastPosition = engine.currentTime
    })
    return () => {
      this.cancelPending(); this.cleanupPosition?.()
      this.cleanups.splice(0).forEach(cleanup => cleanup())
      this.engine = undefined; this.track = undefined
      this.activity(false)
    }
  }
  select(track: PlaybackTrack | null) {
    // Advances are gated at their source. A committed selection must always load.
    const wasStopped = this.stopped
    if (wasStopped) this.userAction()
    if (!wasStopped && !this.selectionPending && track?.key === this.track?.key && track?.origin === this.track?.origin) return
    this.selectionPending = false
    this.cancelPending(); this.cleanupPosition?.()
    const initial = this.firstSelection
    if (track) this.firstSelection = false
    this.track = track || undefined
    this.mediaSource = track && /^(file|blob):/.test(track.src) ? 'local' : undefined
    this.session++; this.attempt = 0; this.authRetries = 0; this.decodeRetries = 0
    this.lastPosition = 0; this.gestureNotified = false; this.savedPosition = null
    if (track && this.mediaSource === undefined && hasBridge()) {
      const session = this.session
      // A pinned/cached head can stall before response headers arrive.
      void bridge().invoke('offline:status', { keys: [track.key] }).then(status => {
        if (session !== this.session || this.mediaSource !== undefined) return
        if (status.tracks.some(row => row.verifiedAt !== null && ['descargado', 'desactualizado', 'ya no está en el nido'].includes(row.state))) {
          this.mediaSource = 'local'
          if (this.retryScheduled) this.armRetry()
        }
      }).catch(() => {})
    }
    // A new session starts at idle; transitions within it use only the table.
    this.publish({ state: 'idle', cause: null })
    if (!track) { if (!initial) clearPosition(this.options.storage); return }
    this.move('loading')
    if (this.skippedTracks.has(this.trackIdentity(track))) { this.stopSkipping(); return }
    if (!this.engine) return
    this.savedPosition = initial ? readPosition(track.origin, track.key, this.options.storage || localStorage) : null
    if (!this.savedPosition) clearPosition(this.options.storage)
    this.cleanupPosition = persistPosition(this.engine, track.origin, track.key,
      () => this.snapshot.state === 'playing', () => this.position(), this.options.storage)
    this.load(false)
  }
  /** Queue actions announce a new selection before React commits it. */
  prepareSelection() { this.cancelPending(); this.selectionPending = true }
  setNext(next: PrefetchTrack | null) { this.engine?.setNext?.(this.stopped ? null : next) }
  private trackIdentity(track: PlaybackTrack) { return JSON.stringify([track.origin, track.key]) }
  private resetSkips() { this.skips = 0; this.skippedTracks.clear() }
  /** Explicit transport/selection actions start a new failure budget. */
  userAction() { this.resetSkips(); this.stopped = false }
  get isStopped() { return this.stopped }
  setBlocked(blocked: boolean) { this.blocked = blocked; if (!blocked) this.drive() }
  setConnected(connected: boolean) {
    if (this.connected === connected) return
    this.connected = connected
    if (!connected && this.mediaSource !== 'local' && this.retryTimer) {
      clearTimeout(this.retryTimer); this.retryTimer = undefined
      this.remaining = Math.max(0, this.deadline - Date.now())
    }
    if (connected && this.retryScheduled) this.armRetry()
  }
  setIntent(intent: boolean, source: 'user' | 'automatic' = 'user') {
    if (source === 'user') this.userAction()
    else if (this.stopped) return
    if (!intent) {
      this.cancelPending(); this.publish({ intent: false })
      if (this.snapshot.state === 'retrying') this.move('loading')
      this.move('paused')
      this.engine?.pause()
      return
    }
    const wasIntent = this.snapshot.intent
    this.publish({ intent: true })
    if (this.snapshot.state === 'loading' || this.snapshot.state === 'buffering') this.beginWait()
    if (this.selectionPending) return
    if (!wasIntent && this.snapshot.state === 'paused') { this.attempt = 0; this.authRetries = 0; this.decodeRetries = 0 }
    if (this.reloadOnPlay || this.snapshot.state === 'failed' || this.snapshot.state === 'ended') {
      this.cancelPending(); this.attempt = 0; this.authRetries = 0; this.decodeRetries = 0
      this.load(true)
    } else if (!wasIntent || this.snapshot.state === 'paused') this.drive()
  }
  private position() { return this.metadata ? this.engine?.currentTime || 0 : this.lastPosition }
  private cancelPending() {
    this.clearWait()
    this.generation++; this.pendingPlay = false
    this.retryScheduled = false
    clearTimeout(this.retryTimer); this.retryTimer = undefined
    clearTimeout(this.stallTimer); this.stallTimer = undefined
    clearTimeout(this.skipTimer); this.skipTimer = undefined
    this.probe?.abort(); this.probe = undefined
  }
  private load(retry: boolean) {
    const engine = this.engine, track = this.track
    if (!engine || !track) return
    this.reloadOnPlay = false
    this.generation++; this.pendingPlay = false; this.metadata = false
    this.resume = retry ? Math.max(0, this.lastPosition - (this.snapshot.cause === 'decode' ? 0 : 2)) : null
    this.move('loading'); this.publish({ cause: null })
    if (import.meta.env.KROBI_PLAYBACK_TRACE === '1') trace('request', this.session, track.key, { retry })
    // Reassign the exact URL: the proxy must re-read credentials, with no URL trick.
    engine.src = track.src; engine.load()
  }
  private drive() {
    if (!this.engine || !this.track || this.selectionPending || this.blocked || this.snapshot.state === 'retrying' || this.snapshot.state === 'failed') return
    if (!this.snapshot.intent || !this.metadata || this.pendingPlay || this.snapshot.state === 'playing') return
    this.pendingPlay = true
    const generation = this.generation
    void this.engine.play().catch((error: unknown) => {
      if (generation !== this.generation) return
      if (error && typeof error === 'object' && 'name' in error && error.name === 'NotAllowedError') {
        this.publish({ intent: false }); this.move('paused')
        if (!this.gestureNotified) { this.gestureNotified = true; this.options.notice('gesture', this.track?.title || '') }
      } else void this.handleError(2)
    }).finally(() => { if (generation === this.generation) this.pendingPlay = false })
  }
  private async handleError(code: number) {
    if (!this.track || !this.engine || this.stopped || this.selectionPending || this.probe || this.retryTimer || this.snapshot.state === 'failed' || this.snapshot.state === 'retrying') return
    this.lastPosition = Math.max(this.lastPosition, this.position())
    this.pendingPlay = false
    if (this.snapshot.state === 'paused') this.move('loading')
    this.move('retrying')
    // Local I/O has no server reachability dependency or finite retry budget.
    if (code === 2 && this.mediaSource === 'local' && this.engine.error?.status !== 404 && this.engine.error?.status !== 410) {
      this.schedule('network', BACKOFF[Math.min(this.attempt++, BACKOFF.length - 1)])
      return
    }
    const generation = ++this.generation
    const probe = new AbortController(); this.probe = probe
    // Probes identify proxy auth/missing errors that WebKit exposes as decode/network.
    let status = this.engine.error?.status ?? (this.mediaSource === 'local' ? 0 : undefined)
    // Synthetic/older ports may lack HTTP status. Real engine fetch errors carry it.
    if (status === undefined) {
      try { status = (await (this.options.fetcher || fetch)(this.track.src, { method: 'HEAD', signal: probe.signal })).status } catch { status = 0 }
    }
    if (generation !== this.generation || probe.signal.aborted) return
    this.probe = undefined
    if (status === 404 || status === 410) {
      this.move('loading')
      this.options.missing?.(this.track)
      this.options.advance()
      return
    }
    if (status === 401) {
      if (this.authRetries++ >= 1) { this.fail('auth'); this.options.notice('auth', this.track.title); return }
      this.schedule('auth', 1000); return
    }
    if (code === 4 && status < 500) { this.failAndSkip('notSupported'); return }
    if (code === 3 && status < 500) {
      if (this.decodeRetries++ >= 1) this.failAndSkip('decode')
      else this.schedule('decode', 0)
      return
    }
    if (this.attempt >= BACKOFF.length) { this.fail('network'); return }
    this.schedule('network', BACKOFF[this.attempt++])
  }
  private schedule(cause: FailureCause, delayMs: number) {
    // A paused source must enter loading before retrying (table invariant).
    if (this.snapshot.state === 'paused') this.move('loading')
    this.move('retrying'); this.publish({ cause })
    this.remaining = delayMs
    this.retryScheduled = true
    if (import.meta.env.KROBI_PLAYBACK_TRACE === '1') trace('retry', this.session, this.track?.key || '', { attempt: cause === 'network' ? this.attempt : 1, cause, delayMs })
    this.armRetry()
  }
  private armRetry() {
    if ((!this.connected && this.mediaSource !== 'local') || !this.retryScheduled || this.probe || this.retryTimer) return
    this.deadline = Date.now() + this.remaining
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      this.retryScheduled = false
      if (this.snapshot.state === 'retrying') this.load(true)
    }, this.remaining)
  }
  private fail(cause: FailureCause) {
    if (this.snapshot.state === 'playing' || this.snapshot.state === 'buffering') this.move('retrying')
    if (this.snapshot.state === 'paused') this.move('loading')
    this.move('failed'); this.publish({ cause })
    if (import.meta.env.KROBI_PLAYBACK_TRACE === '1') trace('failed', this.session, this.track?.key || '', { cause })
  }
  private failAndSkip(cause: 'decode' | 'notSupported') {
    // Unreadable local content still skips, but never offers a manual Retry.
    if (this.mediaSource === 'local') this.publish({ cause })
    else this.fail(cause)
    const skip = () => {
      this.options.notice(cause, this.track?.title || '')
      if (this.track) this.skippedTracks.add(this.trackIdentity(this.track))
      if (++this.skips >= 3) { this.stopSkipping(); return }
      if (import.meta.env.KROBI_PLAYBACK_TRACE === '1') trace('skip', this.session, this.track?.key || '', { cause })
      this.options.advance()
    }
    if (cause === 'decode') this.skipTimer = setTimeout(skip, 3000)
    else skip()
  }
  stopEmptyQueue() {
    if (this.stopped) return
    this.stopped = true
    this.cancelPending()
    this.engine?.setNext?.(null)
    this.publish({ state: 'paused', intent: false })
    this.engine?.pause()
    this.options.notice('empty', '')
  }
  private stopSkipping() {
    if (this.stopped) return
    this.stopped = true
    this.reloadOnPlay = true
    this.cancelPending()
    this.engine?.setNext?.(null)
    this.publish({ intent: false })
    this.move('paused')
    this.engine?.pause()
    this.options.notice('consecutive', this.track?.title || '')
  }
}
