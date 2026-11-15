import { poll } from '../data/poll'
import { useQuery } from '@tanstack/react-query'
import { apiGet, type ApiData } from '../data'

export type DuplicateList = ApiData<'/api/library/duplicates', 'get'>
export type DuplicateGroup = DuplicateList['groups'][number]
export const duplicatesKey = ['library-duplicates'] as const

export function useDuplicates() {
  return useQuery({
    queryKey: duplicatesKey,
    queryFn: ({ signal }) => apiGet('/api/library/duplicates', { signal }),
    refetchInterval: query => poll('active', ['queued', 'running'].includes(query.state.data?.state ?? ''), 1000, false),
  })
}
