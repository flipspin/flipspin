import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { setFakeBridgeForTest } from '../bridge'
import type { KrobiBridge, UploadBatch } from '../lib/ipc'
import { useUploads } from './uploadStore'

let undo: (() => void) | undefined
afterEach(() => undo?.())
it('restores in-progress uploads, holds overlapping batches, releases after all finish', async () => {
  const batch = (id: string, phase: UploadBatch['phase']): UploadBatch => ({ id, phase, files: [], folder: null })
  const events = new Map<string, (value: unknown) => void>()
  const invoke = vi.fn(async (channel: string) => channel === 'upload:status' ? { batches: [batch('one', 'subiendo')] } : { enabled: false })
  undo = setFakeBridgeForTest({ invoke, on: (channel, listener) => { events.set(channel, listener as (value: unknown) => void); return () => events.delete(channel) } } as KrobiBridge)
  const hook = renderHook(() => useUploads())
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('playback:activity', { active: true, reason: 'Uploading music' }))
  act(() => events.get('upload:changed')?.(batch('two', 'revisando')))
  act(() => events.get('upload:changed')?.(batch('one', 'terminado')))
  expect(invoke.mock.calls.filter(([channel]) => channel === 'playback:activity')).toHaveLength(1)
  act(() => events.get('upload:changed')?.(batch('two', 'terminado')))
  expect(invoke).toHaveBeenLastCalledWith('playback:activity', { active: false, reason: 'Uploading music' })
  act(() => events.get('upload:changed')?.(batch('three', 'subiendo')))
  hook.unmount()
  expect(invoke).toHaveBeenLastCalledWith('playback:activity', { active: false, reason: 'Uploading music' })
})
