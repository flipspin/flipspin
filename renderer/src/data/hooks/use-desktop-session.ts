import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { bridge, hasBridge } from '../../bridge'
import { queryKeys } from '../keys'

const sessionKey = queryKeys.desktop.credentials()

export function useDesktopSession() {
  return useQuery({
    queryKey: sessionKey,
    queryFn: () => bridge().invoke('credentials:describe', undefined),
    enabled: hasBridge(),
  })
}

export function useSaveSessionToFile() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const result = await bridge().invoke('credentials:save-to-file', undefined)
      if (!result.ok) throw new Error('session-save-failed')
      await client.invalidateQueries({ queryKey: sessionKey })
    },
  })
}
