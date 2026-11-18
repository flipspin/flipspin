import i18n from '../i18n'
import { useQuery } from '@tanstack/react-query'
import { apiGet, type ApiData } from '../data'
import { useOffline } from '../offline/useOffline'

export type LibraryHealthData = ApiData<'/api/library/health', 'get'>
export type HealthCheck = LibraryHealthData['checks'][number]
export type HealthSource = HealthCheck['source']
export const libraryHealthKey = ['library', 'health'] as const
export const isFixNow = (check: HealthCheck) => check.id === 'missing' || check.id === 'unreadable'
export function fixNowCount(data: LibraryHealthData | undefined): number {
  return data?.checks.filter(isFixNow).reduce((sum, check) => sum + (check.state === 'ready' ? check.count ?? 0 : 0), 0) ?? 0
}
export function healthSourceTitle(source: HealthSource): string {
  return i18n.t("Source: {{store}} · as of {{time}}", { store: source.store, time: source.asOf ?? i18n.t("Not checked_unreviewed") })
}
export function useLibraryHealth(owner: boolean) {
  const offline = useOffline()
  return useQuery({
    queryKey: libraryHealthKey,
    queryFn: ({ signal }) => apiGet('/api/library/health', { signal }),
    enabled: owner && !offline,
    retry: false,
    notifyOnChangeProps: 'all',
    staleTime: 30_000,
  })
}
