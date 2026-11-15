import { poll, startPoll } from '../data/poll'
import { parseTrackPath } from '@lib/api'
import { apiGet, apiPost, isApiError } from '../data'
import { isOriginal, loadMix } from './mix'

type Song = { path: string; relPath?: unknown }
type Key = { album: string; file: string }

/** The stem player's mix, as it saves it (`mix.ts`, `krobi.mix`) on every
 * change. Read at dispatch, not scheduling time, so returning to Original
 * during the debounce cancels.
 */
export function hasBackgroundMix(): boolean {
  return !isOriginal(loadMix())
}

function songKey(song: Song): Key | null {
  const { albumName, fileName } = parseTrackPath(typeof song.relPath === 'string' ? song.relPath : song.path)
  return albumName && fileName ? { album: albumName, file: fileName } : null
}
const id = (song: Key) => JSON.stringify([song.album, song.file])

async function backgroundEnabled(signal: AbortSignal): Promise<boolean> {
  try {
    const config = await apiGet('/api/server/config', { signal })
    return config.groups.some(g => g.settings.some(s => s.key === 'KROBI_STEMS_BACKGROUND' && s.value === true))
  } catch (error) {
    // Config is owner-only. Members use the same scoped background request;
    // the server answers “skipped” when off, and the caller stops immediately.
    if (isApiError(error) && error.status === 403) return true
    throw error
  }
}

/** One scheduler per player. A queue edit or skip aborts the older lookahead.
 * The server remains the authority on caps, scoping and a concurrent switch-off.
 */
export function createBackgroundPreSplit({ readMix = hasBackgroundMix, readEnabled = backgroundEnabled } = {}) {
  let stopPoll: (() => void) | undefined
  let pending: AbortController | undefined
  function cancel() {
    stopPoll?.(); stopPoll = undefined
    pending?.abort()
    pending = undefined
  }
  return {
    cancel,
    schedule(current: Song | null, queue: readonly Song[], playing = true) {
      cancel()
      if (!current || !playing || !queue.length) return
      const controller = new AbortController()
      pending = controller
      const { signal } = controller
      stopPoll = startPoll(() => poll('active', true), () => { stopPoll?.(); return run() }, false)
      async function run() {
        try {
          if (!readMix() || !await readEnabled(signal) || signal.aborted || !readMix()) return
          const { splits } = await apiGet('/api/stems', { signal })
          if (signal.aborted || !readMix()) return
          const ready = new Set(splits.filter(s => !s.stale).map(id))
          const currentKey = songKey(current)
          if (!currentKey || !ready.has(id(currentKey))) return
          const candidates: Key[] = []
          const seen = new Set([id(currentKey)])
          for (const song of queue) {
            const key = songKey(song)
            if (!key || ready.has(id(key)) || seen.has(id(key))) continue
            seen.add(id(key))
            candidates.push(key)
            if (candidates.length === 2) break
          }
          for (const key of candidates) {
            if (signal.aborted || !readMix()) return
            const result = await apiPost('/api/stems/request', { body: { ...key, priority: 'background' }, signal })
            if (result.status === 'skipped') return
          }
        } catch {
          // Background failures belong to Trabajos; playback stays uninterrupted.
        }
      }
    },
  }
}
