import { useQuery } from '@tanstack/react-query'
import { apiGet, type ApiData } from '../http'
import { queryKeys } from '../keys'

export type ServerHost = ApiData<'/api/server/host', 'get'>

/** Deployment details are requested only after the caller is known to own the nest. */
export function useServerHost(owner: boolean) {
  return useQuery({
    queryKey: queryKeys.server.host(),
    queryFn: ({ signal }) => apiGet('/api/server/host', { signal }),
    enabled: owner,
    staleTime: 60_000,
  })
}
