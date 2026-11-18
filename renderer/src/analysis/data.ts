import { useQuery } from '@tanstack/react-query'
import { apiGet } from '../data'
export const analysisKeys = { estimates: ['analysis', 'estimates'] as const, summary: ['analysis', 'summary'] as const, track: (relPath: string) => ['analysis', 'track', relPath] as const }
export function useAnalysisSummary(enabled: boolean) {
  const query = useQuery({ queryKey: analysisKeys.summary, queryFn: ({ signal }) => apiGet('/api/analysis/summary', { signal }), enabled })
  return query
}
