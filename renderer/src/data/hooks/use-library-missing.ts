import { useOffline } from '../../offline/useOffline'
import { load as reloadLibrary, useUserLibrary } from '@state/userLibraryStore'
import { useCallback } from 'react'
import { useQueryClient, useQueries, type QueryClient, type UseQueryResult } from '@tanstack/react-query'
import { isRealUser, useIdentity } from '@state/identityStore'

import { queryGet } from '../http'
import { queryKeys } from '../keys'

type MissingData = { relPaths?: string[] }
const sets = new WeakMap<MissingData, ReadonlySet<string>>()
const empty: ReadonlySet<string> = new Set()

/** A restored file can repoint references in several accounts. Refresh them all. */
export async function refreshRestoredLibrary(client: QueryClient) {
  await reloadLibrary()
  await Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.me.library() }),
    client.invalidateQueries({ queryKey: queryKeys.library.all }),
  ])
}
function pathsFor(data?: MissingData): ReadonlySet<string> {
  if (!data) return empty
  let paths = sets.get(data)
  if (!paths) { paths = new Set(data.relPaths ?? []); sets.set(data, paths) }
  return paths
}

/** One cached listing per account, shared by rows and the Library scope picker. */
export function useLibraryMissing(accountIds?: string[]): ReadonlySet<string> {
  const client = useQueryClient()
  const offline = useOffline()
  const identity = useIdentity()
  const membership = useUserLibrary()
  const enabled = isRealUser(identity)
  const ids = enabled ? [...new Set(accountIds ?? [identity.me.id])] : []
  const idsKey = JSON.stringify(ids)
  const ownId = identity.me?.id
  const removed = membership.removedRelPaths
  const combine = useCallback((queries: UseQueryResult<MissingData>[]): ReadonlySet<string> => {
    const accounts: string[] = JSON.parse(idsKey)
    const paths = new Set<string>()
    queries.forEach((query, i) => {
      for (const path of pathsFor(query.data)) {
        if (accounts[i] !== ownId || !removed?.has(path)) paths.add(path)
      }
    })
    return paths
  }, [idsKey, ownId, removed])
  return useQueries({
    combine,
    queries: ids.map(accountId => ({
      queryKey: queryKeys.me.libraryMissing(accountId),
      enabled: !offline,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        queryGet(client, queryKeys.me.libraryMissing(accountId), '/api/me/library/missing', { params: { query: { accountId } }, signal }),
    })),
  })
}
