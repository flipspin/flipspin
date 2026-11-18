/** Narrow only configured when the server response lacks a model; keep the generated type authoritative. */

import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import type { ApiError } from '../errors'
import { apiGet, type ApiData } from '../http'
import { queryKeys } from '../keys'

export type SpotifyStatus = ApiData<'/api/spotify/status', 'get'>

/** Read every time the screen mounts: keys saved elsewhere must show at once. */
export function useSpotifyStatus(): UseQueryResult<SpotifyStatus, ApiError> {
  return useQuery<SpotifyStatus, ApiError>({
    queryKey: queryKeys.spotify.status(),
    queryFn: ({ signal }) => apiGet('/api/spotify/status', { signal }),
    staleTime: 0,
    refetchOnMount: 'always',
  })
}

/** `true` / `false` when the body says so; `null` when it can't be read. */
export function spotifyConfigured(status: unknown): boolean | null {
  if (status === null || typeof status !== 'object') return null
  const value = (status as Record<string, unknown>).configured
  return typeof value === 'boolean' ? value : null
}
