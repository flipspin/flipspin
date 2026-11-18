import { poll } from '../data/poll'
import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../data'

export const libraryScanKey = ['library', 'scan'] as const

export function useLibraryScan() {
  return useQuery({
    queryKey: libraryScanKey,
    queryFn: ({ signal }) => apiGet('/api/library/scan', { signal }),
    refetchInterval: query => poll('active', !!(query.state.data?.scanning || query.state.data?.pending), 1000, false),
  })
}
