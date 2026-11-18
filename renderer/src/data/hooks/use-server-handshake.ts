/** The public handshake supports server selection and first claim before authentication. */

import { useConnection } from '../../connection/connection'
import type { ServerHandshake } from '../../lib/ipc'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { ApiError } from '../errors'
import { optionalBridge } from '../backend'
import { apiGet, type ApiData, type ApiDataOr } from '../http'
import { queryKeys } from '../keys'

/** Reuse the IPC handshake type for unannotated responses. ApiDataOr prefers
 * the generated model when the server publishes one. */
export type HandshakeData = ApiDataOr<'/api/status', 'get', ServerHandshake>

export function useServerHandshake(enabled = true): UseQueryResult<HandshakeData, ApiError> {
  const connection = useConnection()
  return useQuery<HandshakeData, ApiError>({
    queryKey: queryKeys.server.handshake(),
    enabled: enabled && connection.state === 'connected',
    retry: false,
    queryFn: async ({ signal }) => {
      const connection = optionalBridge()
      if (connection) {
        const { origin } = await connection.invoke('app:get-backend-origin', undefined)
        const result = await connection.invoke('server:probe', { address: origin })
        if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
        if (!result.ok) {
          throw new ApiError({
            kind: 'network',
            method: 'IPC',
            path: '/api/status',
            message: `server probe failed: ${'reason' in result ? result.reason : 'unreachable'}`,
          })
        }
        return readHandshake(result.handshake as ApiData<'/api/status', 'get'>)
      }
      return readHandshake(await apiGet('/api/status', { signal }))
    },

    /** Invalidate the handshake after claim so cached isInit cannot reopen first-run setup.
     * Expire identity facts periodically to notice server replacements. */
    staleTime: 5 * 60_000,
  })
}

/** Narrow the fallback shape once and report mismatches as ApiError before fields reach components. */
function readHandshake(body: ApiData<'/api/status', 'get'>): HandshakeData {
  if (!looksLikeHandshake(body)) {
    throw new ApiError({
      kind: 'malformed',
      status: 200,
      method: 'GET',
      path: '/api/status',
      body,
      message: 'GET /api/status → body is not a handshake',
    })
  }
  return body as HandshakeData
}

function looksLikeHandshake(body: unknown): body is ServerHandshake {
  if (body === null || typeof body !== 'object') return false
  const candidate = body as Partial<ServerHandshake>
  return (
    typeof candidate.app === 'string' &&
    typeof candidate.version === 'string' &&
    typeof candidate.instanceId === 'string' &&
    typeof candidate.isInit === 'boolean' &&
    Array.isArray(candidate.authMethods)
  )
}
