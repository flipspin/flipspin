import { poll } from '../data/poll'
import { watchChanges } from '../data/changeListeners'
import { announceLibraryJob } from '@lib/libraryEvents'
import { useSyncExternalStore } from 'react'
import { subscribeToken } from '../lib/authToken'
import { apiGet, performRequest } from '../data'

export type AcquisitionStage = 'request' | 'match' | 'fetch' | 'import' | 'link'
export type AcquisitionReason = 'no-encontrada' | 'fallo-descarga' | 'fallo-importar' | 'sin-espacio' | 'en-pausa'
export interface AcquisitionItem {
  idx: number; item: string; state: string; reason: AcquisitionReason | null; stage: AcquisitionStage
  detail: { index?: number; until?: number | null; title?: string; [key: string]: unknown }
}
export interface AcquisitionJob {
  id: string; title: string; account_id: string; state: string; provider?: string
  expected_tracks: number; imported_tracks: number; stages: Partial<Record<AcquisitionStage, string>>; items: AcquisitionItem[]
  tracks?: { title: string; artist?: string; duration_s?: number }[]
}
interface Snapshot { requests: AcquisitionJob[]; who: string | null; accountId: string | null; error: boolean; stageIds: ReadonlySet<string> }
let snapshot: Snapshot = { requests: [], who: null, accountId: null, error: false, stageIds: new Set() }
let generation = 0
let pending: Promise<void> | null = null
let stopPoll: (() => void) | undefined
const listeners = new Set<() => void>()
const askedFor = new Set<string>()
const stages = ['request', 'match', 'fetch', 'import', 'link']
export const acquisitionLive = (job: AcquisitionJob) => ['pending', 'approved', 'fetching', 'importing'].includes(job.state)
function publish(value: Snapshot) { snapshot = value; listeners.forEach(listener => listener()) }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' }
// The acquisition routes do not yet publish response schemas. Validate at the wire boundary.
function isRequest(value: unknown): value is AcquisitionJob {
  return isRecord(value) && typeof value.id === 'string' && typeof value.title === 'string'
    && typeof value.account_id === 'string' && typeof value.state === 'string'
    && typeof value.expected_tracks === 'number' && typeof value.imported_tracks === 'number'
}
function isDetail(value: unknown): value is AcquisitionJob {
  return isRequest(value) && isRecord(value.stages) && Object.values(value.stages).every(id => typeof id === 'string')
    && Array.isArray(value.items) && value.items.every(item => isRecord(item) && typeof item.idx === 'number'
      && typeof item.item === 'string' && typeof item.state === 'string' && stages.includes(String(item.stage))
      && (item.reason === null || typeof item.reason === 'string') && isRecord(item.detail))
}
export function refreshAcquisitions(): Promise<void> {
  if (poll('idle') === false) return Promise.resolve()
  if (pending) return pending
  const current = generation
  const task = (async () => {
    try {
      const list = await performRequest('GET', '/api/acquisition/requests', {})
      if (!isRecord(list) || !Array.isArray(list.requests) || !list.requests.every(isRequest)) throw new Error('invalid-acquisitions')
      const [requests, me] = await Promise.all([
        Promise.all(list.requests.map(async row => {
          const detail = await performRequest('GET', '/api/acquisition/requests/{id}', { params: { path: { id: row.id } } })
          if (!isDetail(detail)) throw new Error('invalid-acquisition')
          return detail
        })),
        list.requests.length ? apiGet('/api/me').catch(() => null) : Promise.resolve(null),
      ])
      if (current === generation) {
        requests.forEach(job => announceLibraryJob(`acquisition:${job.id}`, job.state, job.imported_tracks))
        publish({ requests, who: me?.label ?? null, accountId: me?.id ?? null, error: false,
        // Keep retired attempt ids until identity changes, too. The ledger retains them.
        stageIds: new Set([...snapshot.stageIds, ...requests.flatMap(request => Object.values(request.stages))]),
      })
      }
    } catch {
      if (current === generation) publish({ ...snapshot, error: true })
    }
  })()
  pending = task
  void task.finally(() => {
    if (pending !== task) return
    pending = null
  })
  return task
}
function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) stopPoll = watchChanges(['jobs', 'me:<account>'], refreshAcquisitions)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) { stopPoll?.(); stopPoll = undefined; generation++; pending = null }
  }
}
/** The general ledger projects these same stages as download/import jobs.
 * A stage job can reach the ledger poll before the acquisition list has been
 * refreshed, so its id is not in `stageIds` yet: it is recognised by its kind
 * (`acquisition-<stage>`, set by the ledger; the stage label is the fallback for
 * a job view without a kind), hidden, and the list is refreshed so the
 * acquisition's own row shows while it runs. */
export function withoutAcquisitionStages<T extends { id: string; kind?: string | null; label?: string | null }>(jobs: T[], acquisition: Snapshot): T[] {
  let unknown = false
  const kept = jobs.filter(job => {
    if (acquisition.stageIds.has(job.id)) return false
    if (job.kind ? job.kind.startsWith('acquisition-') : Boolean(job.label && stages.includes(job.label))) {
      // One refresh per unseen stage job, never one per render.
      if (!askedFor.has(job.id)) { askedFor.add(job.id); unknown = true }
      return false
    }
    return true
  })
  if (unknown) queueMicrotask(() => { void refreshAcquisitions() })
  return kept
}
export function useAcquisitionJobs() { return useSyncExternalStore(subscribe, () => snapshot) }
export async function clearFinishedAcquisitions() {
  const current = generation
  await performRequest('POST', '/api/acquisition/requests/clear', {})
  if (current !== generation) return
  // The server acknowledged removal. Fence older polls so a stale response
  // cannot restore the rows, even if the follow-up read fails or stalls.
  generation++; pending = null
  publish({ ...snapshot, requests: snapshot.requests.filter(acquisitionLive) })
  await refreshAcquisitions()
}
export async function clearAcquisition(id: string) {
  await performRequest('POST', '/api/acquisition/requests/{id}/clear', { params: { path: { id } } })
  if (pending) await pending
  await refreshAcquisitions()
}
export async function retryAcquisition(id: string, selection?: { index: number; youtube_url: string }) {
  await performRequest('POST', '/api/acquisition/requests/{id}/retry', { params: { path: { id } }, ...(selection ? { body: selection } : {}) })
  if (pending) await pending
  await refreshAcquisitions()
}
subscribeToken(() => {
  generation++; pending = null
  publish({ requests: [], who: null, accountId: null, error: false, stageIds: new Set() })
  if (listeners.size) void refreshAcquisitions()
})
