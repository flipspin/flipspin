import { useEffect, useState } from 'react'
import { backendRequest } from '@lib/api'
import { useConnection } from '../connection/connection'
import { useSnapshotReads } from '../offline/useOffline'
import { bridge, hasBridge } from '../bridge'
import type { ListedAlbum } from './decorateTrack'

/** Home uses the same durable snapshot path as the library. No second cache. */
export function useHomeRows() {
  const connection = useConnection()
  const saved = useSnapshotReads()
  const [rows, setRows] = useState<{ albums: ListedAlbum[]; at: number | null } | null>(null)
  useEffect(() => {
    let alive = true, revision = 0
    let controller: AbortController | undefined
    const refresh = () => {
      const version = ++revision
      controller?.abort()
      controller = new AbortController()
      if (connection.state !== 'connected' && !saved) return
      void backendRequest('/api/me/home', { signal: controller.signal }).then(response => {
        if (!alive || version !== revision || !response.ok) return
        const body = JSON.parse(response.body) as { albums?: ListedAlbum[] }
        if (Array.isArray(body.albums)) setRows({ albums: body.albums, at: response.headers['x-krobi-snapshot-at'] ? Number(response.headers['x-krobi-snapshot-at']) : null })
      }).catch(() => { /* Unknown is not an empty shelf. Keep the listing fallback. */ })
    }
    refresh()
    const stop = hasBridge() ? bridge().on('auth:changed', () => { setRows(null); refresh() }) : () => {}
    window.addEventListener('library-changed', refresh)
    return () => { alive = false; revision++; controller?.abort(); stop(); window.removeEventListener('library-changed', refresh) }
  }, [connection.state, saved])
  return connection.state === 'wrong-nest' ? null : rows
}
