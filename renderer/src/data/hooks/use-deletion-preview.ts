/** A fresh preview per dialog opening; never poll while the person decides. */
import { useQuery } from '@tanstack/react-query'
import { apiDelete, apiGet } from '../http'
import { queryKeys } from '../keys'

export function useDeletionPreview(userId: string) {
  return useQuery({
    queryKey: [...queryKeys.household.all, 'deletion-preview', userId],
    queryFn: ({ signal }) => apiGet('/api/users/{user_id}/deletion-preview', { params: { path: { user_id: userId } }, signal }),
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: 'always',
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
}

export function deleteAccount(userId: string, songs: boolean) {
  return apiDelete('/api/users/{user_id}', { params: { path: { user_id: userId }, query: { songs } } })
}
