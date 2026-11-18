import { setLibraryPresence } from '../library/trackPresence'
import { queryRevision } from './http'
import type { LibraryAlbums } from './hooks/use-library-albums'
/**
 * The data layer's single mount point. Wrap the app in this once.
 */

import { focusManager, onlineManager, QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'
import { getState as libraryState, subscribe as subscribeLibrary, load as reloadLibrary, resetLibrary } from '@state/userLibraryStore'

import { announceLibraryChanged, resetLibraryJobs } from '@lib/libraryEvents'
import type { OfflineTrackStatus } from '../lib/ipc'
import { useConnection } from '../connection/connection'
import { getForcedOffline, useForcedOffline } from '../offline/mode'
import { isOfflineNow } from '../offline/policy'
import { logger } from '../lib/logger'

import { optionalBridge } from './backend'
import { poll } from './poll'
import { startChanges } from './changes'
import { watchChanges } from './changeListeners'
import { createQueryClient } from './query-client'
import { queryKeys } from './keys'
import { LibraryMissingProvider } from './library-missing-context'

interface DataProviderProps {
  children: ReactNode
  /**
   * An externally built cache. Tests pass one so they can inspect it and so a
   * failing query does not sit through the production retry policy; the app
   * passes nothing.
   */
  queryClient?: QueryClient
}

export function DataProvider({ children, queryClient }: DataProviderProps): React.JSX.Element {
  const status = useConnection()
  const forced = useForcedOffline()
  // Built in a lazy initialiser, not inline. `new QueryClient()` in the render
  // body constructs a fresh cache on every render and throws the previous one
  // away, which reads as "every screen refetches constantly" and is remarkably
  // hard to see.
  const [client] = useState(() => queryClient ?? createQueryClient())

  useEffect(() => {
    const key = queryKeys.library.albums({ covers: false })
    const sync = () => {
      const data = client.getQueryData<LibraryAlbums>(key)
      setLibraryPresence(data, queryRevision(client, key) ?? data)
    }
    sync()
    const off = client.getQueryCache().subscribe(sync)
    return () => { off(); setLibraryPresence() }
  }, [client])

  useEffect(() => {
    focusManager.setEventListener(setFocused => {
      const native = optionalBridge()
      let nativeFocused = !document.hidden
      const update = () => setFocused(nativeFocused && !document.hidden)
      const off = native?.on('window:focus', focused => { nativeFocused = focused; update() })
      const visibility = () => { if (!native) nativeFocused = !document.hidden; update() }
      update()
      document.addEventListener('visibilitychange', visibility)
      return () => { off?.(); document.removeEventListener('visibilitychange', visibility) }
    })
    return () => {
      focusManager.setEventListener(setFocused => {
        const visibility = () => setFocused(!document.hidden)
        document.addEventListener('visibilitychange', visibility)
        return () => document.removeEventListener('visibilitychange', visibility)
      })
    }
  }, [])

  useEffect(() => startChanges(client, optionalBridge()), [client])

  useEffect(() => {
    let rows = libraryState().byRelPath
    let pending: number | undefined
    let reloading: Promise<void> | undefined
    let alive = true
    const canRefresh = () => poll('idle') !== false && onlineManager.isOnline() && !getForcedOffline() && !isOfflineNow()
    const songCount = () => {
      const albums = client.getQueryData(queryKeys.library.albums({ covers: false }))
      return Array.isArray(albums) ? albums.reduce((total, album) => total + (Array.isArray(album.tracks) ? album.tracks.length : 0), 0) : 0
    }
    const refreshAccountQueries = () => client.invalidateQueries({ queryKey: queryKeys.me.library() })
    const refresh = (source = '') => {
      if (!canRefresh() || reloading || pending !== undefined) return
      const before = songCount()
      reloading = (async () => {
        try {
          await Promise.all([
            client.invalidateQueries({ queryKey: queryKeys.library.all, type: 'active' }), refreshAccountQueries(),
            reloadLibrary(),
          ])
          if (alive && canRefresh()) logger.debug(`Biblioteca al día tras cambio local${source ? ` (${source})` : ''} · ${before} → ${songCount()} canciones`)
        } finally {
          reloading = undefined
        }
      })()
      return reloading
    }
    let because = ''
    const schedule = (event?: Event) => {
      if (!canRefresh() || pending !== undefined) return
      because = String((event as CustomEvent<{ source?: string }> | undefined)?.detail?.source ?? 'otro')
      // First event wins: an album can finish as several jobs, and the nest
      // still needs a second to finish filing their songs. Do not debounce.
      pending = window.setTimeout(() => {
        const scheduled = pending
        // A job arriving during a reload still deserves a later refresh.
        void (async () => {
          await reloading
          if (!alive || pending !== scheduled) return
          pending = undefined
          await refresh(because)
        })()
      }, 1_000)
    }
    const changes = watchChanges(['library', 'me:<account>'], async () => {
      if (!canRefresh()) return
      reloading = reloadLibrary()
      try { await reloading } finally { reloading = undefined }
    }, false)
    const unsubscribe = subscribeLibrary(() => {
      const next = libraryState().byRelPath
      if (rows !== next) {
        rows = next
        if (canRefresh() && !reloading) void refreshAccountQueries()
      }
    })
    const cancelPending = () => { window.clearTimeout(pending); pending = undefined }
    const auth = optionalBridge()?.on('auth:changed', cancelPending)
    window.addEventListener('library-changed', schedule)
    return () => {
      alive = false
      cancelPending(); auth?.(); unsubscribe(); changes()
      window.removeEventListener('library-changed', schedule)
    }
  }, [client, forced])

  // Device transfers already push offline:changed; read that store once per
  // event, never a timer per download. Only newly completed files invalidate.
  useEffect(() => {
    const bridge = optionalBridge()
    if (!bridge) return
    let alive = true, revision = 0
    let states = new Map<string, OfflineTrackStatus['state']>()
    const refresh = () => {
      const version = ++revision
      void bridge.invoke('offline:status', { keys: [] }).then(value => {
        if (!alive || version !== revision || !value) return
        const changed = value.tracks.some(track => track.pool === 'offline' && track.state === 'descargado' && states.get(track.key) !== 'descargado')
        states = new Map(value.tracks.map(track => [track.key, track.state]))
        if (changed) announceLibraryChanged('descarga en este equipo')
      }).catch(() => {})
    }
    const off = bridge.on('offline:changed', refresh)
    const auth = bridge.on('auth:changed', () => { revision++; states = new Map(); resetLibraryJobs() })
    refresh()
    return () => { alive = false; revision++; off(); auth() }
  }, [client])

  useEffect(() => {
    if (status.state === 'wrong-nest') { client.clear(); resetLibrary() }
  }, [client, status.state])

  useEffect(() => {
    const connection = optionalBridge()
    // No bridge means this page is not running inside the shell; a browser dev
    // session or a test that did not install one. Nothing will ever emit
    // `auth:changed`, so there is nothing to subscribe to.
    if (!connection) return

    return connection.on('auth:changed', () => {
      // Clear cached rows on credential changes in every window. Invalidation retains data
      // and can briefly display the previous account while refetching.
      client.clear()
      resetLibrary()
    })
  }, [client])

  return <QueryClientProvider client={client}><LibraryMissingProvider>{children}</LibraryMissingProvider></QueryClientProvider>
}
