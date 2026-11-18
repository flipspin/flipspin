import { useEffect, useSyncExternalStore } from 'react'
import { bridge, hasBridge } from '../bridge'
import { activityHold } from '../player/activity'
import { announceLibraryJob } from '../lib/libraryEvents'
import type { UploadBatch, UploadChoice, UploadItem } from '../lib/ipc'

export function isRetryableUpload(file: UploadItem) {
  return file.state === 'fallida' && file.reason != null && ['changed', 'unreadable', 'sin-espacio', 'fallo-subida'].includes(file.reason)
}

type State = { batch: UploadBatch | null; busy: boolean; problem: string | null; sheetOpen: boolean; keepAwake: boolean | null; preferenceBusy: boolean }
const empty: State = { batch: null, busy: false, problem: null, sheetOpen: false, keepAwake: null, preferenceBusy: false }
let state = empty
let owners = 0
let inlineOwners = 0
let generation = 0
let revision = 0
let preferenceRevision = 0
let disconnect = () => {}
let presentation: 'inline' | 'sheet' = 'sheet'
const activity = activityHold('Uploading music')
const activeBatches = new Set<string>()
function clearActivity() { activeBatches.clear(); activity(false) }
const listeners = new Set<() => void>()
function update(patch: Partial<State>) {
  state = { ...state, ...patch }
  listeners.forEach(listener => listener())
}
function accept(batch: UploadBatch) {
  if (batch.phase === 'revisando' || batch.phase === 'subiendo') activeBatches.add(batch.id)
  else activeBatches.delete(batch.id)
  activity(activeBatches.size > 0)
  revision++
  if (state.batch && state.batch.id !== batch.id && batch.phase === 'terminado') return
  update({ batch, ...(batch.keepAwake == null ? {} : { keepAwake: batch.keepAwake }) })
  if (batch.phase === 'revisando' && presentation === 'sheet' && !inlineOwners) update({ sheetOpen: true })
  announceLibraryJob(`upload:${batch.id}`, batch.phase)
}
function connect() {
  if (!hasBridge()) return () => {}
  if (owners++ === 0) {
    const link = bridge()
    const restore = () => {
      const epoch = ++generation
      const readRevision = revision
      const readPreference = preferenceRevision
      void link.invoke('upload:status', undefined).then(result => {
        if (epoch !== generation || revision !== readRevision) return
        for (const batch of result.batches || []) {
          if (batch.phase === 'revisando' || batch.phase === 'subiendo') activeBatches.add(batch.id)
        }
        activity(activeBatches.size > 0)
        const active = result.batches?.find(batch => batch.phase !== 'terminado')
        if (active) { accept(active); if (!inlineOwners && presentation === 'sheet') update({ sheetOpen: true }) }
      }).catch(() => undefined)
      void link.invoke('upload:keep-awake', {}).then(result => {
        if (epoch === generation && preferenceRevision === readPreference) update({ keepAwake: result.enabled })
      }).catch(() => undefined)
    }
    const off = link.on('upload:changed', accept)
    const errors = link.on('upload:error', error => update({ problem: error, sheetOpen: !inlineOwners && presentation === 'sheet' }))
    const auth = link.on('auth:changed', () => { clearActivity(); update(empty); restore() })
    restore()
    disconnect = () => { off(); errors(); auth(); generation++ }
  }
  return () => {
    if (--owners === 0) { disconnect(); clearActivity(); state = empty; presentation = 'sheet' }
  }
}
export function useUploads(inline = false) {
  useEffect(() => {
    if (inline) { inlineOwners++; presentation = 'inline'; update({ sheetOpen: false }) }
    const off = connect()
    return () => { if (inline) inlineOwners--; off() }
  }, [inline])
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => state)
}
async function run(action: () => Promise<UploadBatch | null>) {
  if (state.busy) return
  const epoch = generation
  const actionRevision = revision
  update({ busy: true, problem: null })
  try { const batch = await action(); if (epoch === generation && actionRevision === revision && batch) accept(batch) }
  catch (error) { if (epoch === generation) update({ problem: String(error) }) }
  finally { if (epoch === generation) update({ busy: false }) }
}
export const uploadActions = {
  pick(kind: 'folder' | 'files', where: 'inline' | 'sheet') {
    presentation = where
    return run(() => bridge().invoke('upload:start', { pick: kind }))
  },
  start(duplicates: UploadChoice = 'use-nest') {
    const batch = state.batch
    return run(() => batch ? bridge().invoke('upload:start', { id: batch.id, duplicates }) : Promise.resolve(null))
  },
  stop() {
    const batch = state.batch
    return run(() => batch ? bridge().invoke('upload:stop', { id: batch.id }) : Promise.resolve(null))
  },
  retry() {
    const batch = state.batch
    return run(() => batch ? bridge().invoke('upload:retry-failed', { id: batch.id }) : Promise.resolve(null))
  },
  closeSheet() { update({ sheetOpen: false }) },
  openSheet(id?: string) {
    presentation = 'sheet'
    update({ sheetOpen: true, problem: null, ...(!id && state.batch?.phase === 'terminado' ? { batch: null } : {}) })
    if (id && hasBridge()) void run(async () => (await bridge().invoke('upload:status', undefined)).batches.find(batch => batch.id === id) ?? null)
  },
  async keepAwake(enabled: boolean) {
    if (state.preferenceBusy) return
    const epoch = generation
    preferenceRevision++
    update({ preferenceBusy: true, problem: null })
    try {
      const result = await bridge().invoke('upload:keep-awake', { enabled })
      if (epoch === generation) update({ keepAwake: result.enabled })
    } catch (error) { if (epoch === generation) update({ problem: String(error) }) }
    finally { if (epoch === generation) update({ preferenceBusy: false }) }
  },
}
