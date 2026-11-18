/** Resolve the current principal through /api/me; stored credentials alone do not identify an account. */

import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import type { ApiError } from '../errors'
import { apiGet, type ApiData } from '../http'
import { queryKeys } from '../keys'

/** Use the generated response type so server model changes reach callers without a second interface. */
export type CurrentUser = ApiData<'/api/me', 'get'>

export function useCurrentUser(): UseQueryResult<CurrentUser, ApiError> {
  return useQuery<CurrentUser, ApiError>({
    queryKey: queryKeys.me.profile(),
    queryFn: ({ signal }) => apiGet('/api/me', { signal }),

    /** 401 requires sign-in; 409 means a synthetic principal has no account row.
     * Keep both statuses intact for the caller and do not retry them. */
    staleTime: 5 * 60_000,
  })
}
