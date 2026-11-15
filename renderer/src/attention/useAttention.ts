import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiGet, queryKeys, type ApiData } from '../data'

export type Attention = ApiData<'/api/me/attention', 'get'>

/** A minute in the background; opening the menu always asks for current facts. */
export function useAttention(owner: boolean, open: boolean) {
  const query = useQuery({
    queryKey: queryKeys.me.attention(),
    queryFn: ({ signal }) => apiGet('/api/me/attention', { signal }),
    enabled: owner,
    staleTime: 60_000,
    retry: false,
  })
  const { refetch } = query
  useEffect(() => { if (owner && open) void refetch() }, [owner, open, refetch])
  return { ...query, data: owner && !query.isError ? query.data : undefined }
}
