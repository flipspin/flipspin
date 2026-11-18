import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiDelete, apiGet, apiPut, performRequest } from '../http'
import { queryKeys } from '../keys'
import { bridge, hasBridge } from '../../bridge'
import type { ApiData } from '../http'
import type { SchemaKeyExportRequest } from '../../api/generated/schema'

export type SecretsStatus = ApiData<'/api/server/secrets', 'get'>
export type SecretStatus = SecretsStatus['secrets'][number]
const secretsKey = queryKeys.server.secrets()

export function useSecrets() {
  return useQuery({ queryKey: secretsKey, queryFn: ({ signal }) => apiGet('/api/server/secrets', { signal }) })
}

export function useChangeSecrets() {
  const client = useQueryClient()
  return useMutation({
    gcTime: 0,
    mutationFn: async ({ names, values }: { names: string[]; values: string[] | null }) => {
      if (values && names[0] === 'SPOTIFY_CLIENT_ID') {
        await apiPut('/api/config/spotify', { body: { client_id: values[0], client_secret: values[1] } })
      } else {
        for (const [i, name] of names.entries()) {
          const params = { path: { name } }
          if (values) await apiPut('/api/server/secrets/{name}', { params, body: { value: values[i] } })
          else await apiDelete('/api/server/secrets/{name}', { params })
        }
      }
      return client.fetchQuery({ queryKey: secretsKey, queryFn: () => apiGet('/api/server/secrets'), staleTime: 0 })
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: secretsKey })
      void client.invalidateQueries({ queryKey: queryKeys.server.providers() })
      void client.invalidateQueries({ queryKey: queryKeys.spotify.status() })
    },
  })
}

export function useExportKey() {
  return useMutation({
    // Keep the attachment out of the query/mutation cache after saving it.
    mutationFn: async ({ password, fingerprint }: SchemaKeyExportRequest & { fingerprint: string }) => {
      const reply: unknown = await performRequest('POST', '/api/server/secrets/key/export', { body: { password }, parseAs: 'blob' })
      // Duck-typed: a Blob from another realm (undici's under some Node versions) fails `instanceof Blob`.
      if (!reply || typeof (reply as Blob).text !== 'function') throw new Error('invalid-key-attachment')
      const blob = reply as Blob
      const name = `krobi-nido-${fingerprint}.key`
      if (hasBridge()) {
        const saved = await bridge().invoke('files:save-key-export', { name, contents: await blob.text() })
        if (!saved.ok) throw new Error('key-save-failed')
        return !saved.cancelled
      }
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      return true
    },
    gcTime: 0,
  })
}
