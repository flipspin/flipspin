/**
 * `GET /api/listar-albums-con-metadata`; the shared catalog on disk.
 */

import { useOffline } from '../../offline/useOffline'
import { useConnection } from '../../connection/connection'
import { snapshotResponse } from '../../offline/snapshots'
import { useCallback, useEffect, useRef } from 'react'
import { useQueryClient, useQuery, type UseQueryResult } from '@tanstack/react-query'

import { relPathOf, useUserLibrary } from '@state/userLibraryStore'
import { isRealUser, useIdentity } from '@state/identityStore'
import { narrowAlbums } from '../../albums/libraryPanel'
import { ApiError } from '../errors'
import { queryGet, recordQueryHeaders, type ApiData } from '../http'
import { queryKeys } from '../keys'
import { logger } from '../../lib/logger'

/** Always disable inline covers: base64 album lists are costly over remote connections.
 * Fetch covers lazily using album directories, which can differ from display names. */
const COVERS = false

/** Use the generated album response type so server annotations reach every caller. */
export type LibraryAlbums = ApiData<'/api/listar-albums-con-metadata', 'get'>

export function useLibraryAlbums(): UseQueryResult<LibraryAlbums, ApiError> {
  const offline = useOffline()
  const connection = useConnection()
  const client = useQueryClient()
  const membership = useUserLibrary()
  const identity = useIdentity()
  const personal = isRealUser(identity) && !identity.me.isOwner && membership.capability === 'ready'
  const rows = membership.byRelPath
  const select = useCallback((data: LibraryAlbums) => {
    if (!personal || !Array.isArray(data)) return data
    return narrowAlbums(data, track => !!rows[relPathOf(track)])
  }, [personal, rows])
  const query = useQuery<LibraryAlbums, ApiError>({
    select,
    // The flag is part of the key because it is part of the response. Two
    // different bodies under one key is a cache that serves whichever arrived
    // last, and here the difference between them is 30 MB.
    enabled: connection.state !== 'wrong-nest' && connection.state !== 'needs-auth',
    networkMode: offline ? 'always' : 'online',
    queryKey: queryKeys.library.albums({ covers: COVERS }),
    queryFn: async ({ signal }) => {
      const started = performance.now()
      const data = await queryGet(client, queryKeys.library.albums({ covers: COVERS }), '/api/listar-albums-con-metadata', { params: { query: { covers: COVERS } }, signal })
      if (!Array.isArray(data)) throw new ApiError({ kind: 'malformed', method: 'GET', path: '/api/listar-albums-con-metadata', message: 'Invalid album listing' })
      const took = performance.now() - started
      if (took > 150) logger.debug(`Listado de álbumes · ${Math.round(took)} ms · ${data.length} álbumes`)
      return data
    },
  })
  // Local reads can fill a paused query; they never authorize network traffic.
  useEffect(() => {
    if (connection.state !== 'connecting') return
    let alive = true
    const key = queryKeys.library.albums({ covers: COVERS })
    const entry = client.getQueryCache().find({ queryKey: key, exact: true })
    void snapshotResponse('/api/listar-albums-con-metadata').then(response => {
      if (alive && response?.ok && client.getQueryCache().find({ queryKey: key, exact: true }) === entry) {
        recordQueryHeaders(client, key, new Headers(response.headers))
        client.setQueryData(key, JSON.parse(response.body) as LibraryAlbums, { updatedAt: 0 })
      }
    }).catch(() => {})
    return () => { alive = false }
  }, [connection.state, client])
  const refetch = query.refetch
  const previous = useRef(offline)
  useEffect(() => {
    const changed = previous.current !== offline
    previous.current = offline
    if (offline || changed) void client.cancelQueries({ queryKey: queryKeys.library.albums({ covers: COVERS }), exact: true }).then(() => refetch())
  }, [offline, client, refetch])
  return query

}
