/**
 * The lyrics engine's state in one word, from the server's snapshot
 * (`jobs.engine`) and, in agent mode, whether a computer is claiming work.
 */
import { msg } from '../i18n'
import type { LyricsEngine, LyricsJobs } from '../lyrics/lyricsStore'
import type { Tone } from './parts'
import { HELPER_STATES } from './helper'

export interface EngineWord {
  word: string
  tone: Tone
  /** A known helper is unavailable: the engine is stopped. */
  stopped: boolean
}

export function engineWord(engine: LyricsEngine | null | undefined): EngineWord | null {
  if (!engine) return null
  if (engine.mode === 'agent' && engine.helpers?.length) {
    const live = engine.helpers.find(h => h.state === 'working' || h.state === 'idle')
    const state = (live ?? engine.helpers[0]).state
    return { ...HELPER_STATES[state], stopped: !live }
  }
  if (engine.running) return { word: msg("working"), tone: 'ok', stopped: false }
  if (engine.installing) return { word: msg("installing"), tone: 'none', stopped: false }
  if (engine.mode === 'agent') {
    return engine.queue?.online
      ? { word: msg("running"), tone: 'ok', stopped: false }
      : { word: msg("No helper is processing for the nest"), tone: 'none', stopped: false }
  }
  switch (engine.hint) {
    case 'ready':
      return { word: msg("ready"), tone: 'ok', stopped: false }
    case 'not-installed':
    case 'no-python':
      return { word: msg("not installed_withoutInstall"), tone: 'off', stopped: false }
    case 'no-uv':
      return { word: msg("a component is missing (uv)"), tone: 'warn', stopped: false }
    case 'unsupported-platform':
      return { word: msg("not available on this computer"), tone: 'off', stopped: false }
    case 'models-missing':
      return { word: msg("models missing"), tone: 'warn', stopped: false }
    default:
      return { word: msg("failing"), tone: 'bad', stopped: false }
  }
}

/** Songs the catalogs lacked: what the engine is there to eat. */
export function waiting(jobs: LyricsJobs | null | undefined): number {
  return jobs?.pendingCount ?? 0
}

export { installFailure } from '../lyrics/installErrors'
