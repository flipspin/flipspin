import { log } from '../lib/log'

type TraceEvent = 'request' | 'firstByte' | 'canplay' | 'playing' | 'waiting' | 'stalled' | 'retry' | 'failed' | 'seeking' | 'seeked' | 'ended' | 'skip' | 'prefetch' | 'gain' | 'boundary'
interface TraceRow { t: number; session: number; key: string; event: TraceEvent; [key: string]: unknown }
const CAPACITY = 256
let rows: TraceRow[] = []
let timer: ReturnType<typeof setInterval> | undefined
let started = 0, waiting = 0, seeking = 0, currentSession = 0
let firstByte = false
let currentKey = ''
let stats = { startup: 0, rebufferCount: 0, rebufferMs: 0, seekMs: 0, lastError: '', gain: 1, cacheHit: null as boolean | null }
const listeners = new Set<() => void>()
export const traceStore = {
  subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  getSnapshot: () => stats,
}

export function traceGain(fields: Record<string, unknown>) {
  trace('gain', currentSession, currentKey, fields)
}

/** All callers are guarded by the literal build-time flag, including gain. */
export function trace(event: TraceEvent, session: number, key: string, fields: Record<string, unknown> = {}) {
  if (import.meta.env.KROBI_PLAYBACK_TRACE !== '1') return
  const t = performance.now()
  currentKey = key
  if (session !== currentSession) {
    currentSession = session; started = t; waiting = 0; seeking = 0
    stats = { startup: 0, rebufferCount: 0, rebufferMs: 0, seekMs: 0, lastError: '', gain: 1, cacheHit: null }
  }
  stats = { ...stats }
  if (event === 'request') { firstByte = false; if (!fields.retry) started = t }
  if (event === 'firstByte') { if (firstByte) return; firstByte = true }
  if (event === 'waiting' && !waiting) { waiting = t; stats.rebufferCount++ }
  if (event === 'playing') {
    if (!stats.startup) stats.startup = t - started
    if (waiting) { stats.rebufferMs += t - waiting; waiting = 0 }
  }
  if (event === 'seeking') seeking = t
  if (event === 'seeked' && seeking) { stats.seekMs = t - seeking; seeking = 0 }
  if (event === 'failed') stats.lastError = String(fields.cause)
  if (event === 'gain') stats.gain = Number(fields.linear)
  if (event === 'firstByte' && typeof fields.cacheHit === 'boolean') stats.cacheHit = fields.cacheHit
  rows.push({ t, session, key, event, ...fields })
  if (rows.length > CAPACITY) rows = rows.slice(-CAPACITY)
  timer ??= setInterval(() => {
    if (rows.length) log.playback.debug('__krobi_trace__', rows.splice(0))
    listeners.forEach(listener => listener())
  }, 2000)
}
