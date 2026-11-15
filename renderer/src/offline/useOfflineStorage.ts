import { useCallback, useEffect, useRef, useState } from 'react'
import { subscribeToken } from '../lib/authToken'
import { bridge, hasBridge } from '../bridge'
import type { OfflinePools, OfflineStatus, OfflineTrackStatus } from '../lib/ipc'
import { msg } from '../i18n'

export const OFFLINE_REASONS: Record<string, string> = {
  'no-space': msg("Out of space"),
  'track-missing': msg("No longer on the nest"),
  'library-required-online': msg("Offline"),
  'library-add-failed': msg("Could not add to library"),
}
export function offlineReason(track: OfflineTrackStatus): string {
  if (track.state === 'ya no está en el nido') return msg("No longer on the nest")
  return OFFLINE_REASONS[track.error ?? ''] ?? msg("Download failed")
}

/** Reads only the scoped shell store. Invalidation never invents reachability. */
export function useOfflineStorage() {
  const [data, setData] = useState<{ pools: OfflinePools; status: OfflineStatus } | null>(null)
  const [error, setError] = useState(false)
  const generation = useRef(0)
  const refresh = useCallback(async () => {
    const current = ++generation.current
    try {
      const [pools, status] = await Promise.all([
        bridge().invoke('offline:pools', { action: 'get' }),
        bridge().invoke('offline:status', { keys: [] }),
      ])
      if (current === generation.current) { setData({ pools, status }); setError(false) }
    } catch {
      if (current === generation.current) setError(true)
    }
  }, [])
  useEffect(() => {
    void refresh()
    const off = hasBridge() ? bridge().on('offline:changed', () => { void refresh() }) : undefined
    const identity = subscribeToken(() => { setData(null); void refresh() })
    const version = generation
    return () => { version.current++; off?.(); identity() }
  }, [refresh])
  return { data, error, refresh }
}

/** Reuse the owning pins, preserving collection membership and refcounts. */
export async function changeOfflineTrack(pools: OfflinePools, key: string, remove: boolean) {
  return changeOfflineTracks(pools, [key], remove)
}

/** Batch subtraction must happen once per pin, preserving unselected songs. */
export async function changeOfflineTracks(pools: OfflinePools, keys: string[], remove: boolean) {
  if (!pools.pins) throw new Error('storage-controls-unavailable')
  const selected = new Set(keys)
  for (const pin of pools.pins.filter(pin => pin.tracks.some(key => selected.has(key)))) {
    const tracks = remove ? pin.tracks.filter(track => !selected.has(track)) : pin.tracks
    if (!tracks.length && pin.kind !== 'library') {
      await bridge().invoke('offline:unpin', { pinId: pin.id })
    } else {
      const result = await bridge().invoke('offline:pin', {
        kind: pin.kind, ref: pin.ref, tracks: tracks.map(key => ({ key, inLibrary: true })),
      })
      if (result.ok === false) throw new Error(result.reason)
    }
  }
}
