/** Use production query defaults so tests cover real refusal and retry policy. */

import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'

import { DataProvider } from './provider'
import { createQueryClient } from './query-client'
import { queryKeys } from './keys'
import { useCurrentUser } from './hooks/use-current-user'
import { useLibraryAlbums } from './hooks/use-library-albums'
import { useServerHandshake } from './hooks/use-server-handshake'
import { installFakeBackend, type FakeBackend } from './test-support'

const HANDSHAKE = {
  app: 'krobi',
  version: '2.1.2',
  instanceId: 'abc123',
  isInit: true,
  authMethods: ['token'],
}

let backend: FakeBackend | null = null

afterEach(() => {
  backend?.restore()
  backend = null
})

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <DataProvider queryClient={queryClient}>{children}</DataProvider>
  }
}

describe('useServerHandshake', () => {
  it('resolves the handshake through the whole layer', async () => {
    backend = installFakeBackend({ respond: () => ({ status: 200, json: HANDSHAKE }) })
    const { result } = renderHook(() => useServerHandshake(), { wrapper: wrapperFor(createQueryClient()) })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data?.instanceId).toBe('abc123')
    expect(result.current.data?.isInit).toBe(true)
  })

  it('fails loudly when the body is not a handshake', async () => {
    // Reject malformed bodies before missing fields can reach the screen.
    backend = installFakeBackend({ respond: () => ({ status: 200, json: { hello: 'world' } }) })
    const { result } = renderHook(() => useServerHandshake(), { wrapper: wrapperFor(createQueryClient()) })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.error?.kind).toBe('malformed')
  })
})

describe('useCurrentUser', () => {
  it('surfaces a 401 once, without retrying it', async () => {
    backend = installFakeBackend({ respond: () => ({ status: 401, json: { detail: 'Invalid or missing API token' } }) })
    const { result } = renderHook(() => useCurrentUser(), { wrapper: wrapperFor(createQueryClient()) })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.error?.status).toBe(401)
    // Refused requests must finish after one attempt.
    expect(backend.countFor('/api/me')).toBe(1)
  })

  it('does retry a server-side failure', async () => {
    // The positive control. Without it, "never retries a 4xx" would also pass
    // for a client that never retries anything at all.
    const client = createQueryClient()
    // Only the delay is replaced; the predicate under test is untouched.
    // Real backoff would spend 1.2 seconds sleeping inside this assertion.
    client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retryDelay: 0 } })

    backend = installFakeBackend({ respond: () => ({ status: 503, json: { detail: 'starting up' } }) })
    const { result } = renderHook(() => useCurrentUser(), { wrapper: wrapperFor(client) })

    await waitFor(() => expect(result.current.isError).toBe(true))

    expect(result.current.error?.status).toBe(503)
    expect(backend.countFor('/api/me')).toBe(3)
  })
})

describe('useLibraryAlbums', () => {
  it('asks for the library without inlined covers', async () => {
    backend = installFakeBackend({ respond: () => ({ status: 200, json: [] }) })
    const { result } = renderHook(() => useLibraryAlbums(), { wrapper: wrapperFor(createQueryClient()) })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // 175 KB with the flag, ~32 MB without it.
    expect(backend.requests[0]?.search).toBe('?covers=false')
  })
})

describe('DataProvider', () => {
  it('drops every cached answer when the credential changes', async () => {
    backend = installFakeBackend({ respond: () => ({ status: 200, json: HANDSHAKE }) })
    const client = createQueryClient()
    const { result } = renderHook(() => useServerHandshake(), { wrapper: wrapperFor(client) })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    act(() => {
      backend?.emitAuthChanged({ userId: 'someone-else', hasToken: true })
    })

    // Clear identity-scoped data so a refetch cannot briefly display another account's rows.
    expect(client.getQueryData(queryKeys.server.handshake())).toBeUndefined()
  })
})
