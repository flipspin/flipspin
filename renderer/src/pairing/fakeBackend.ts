/** Fake fetch so tests exercise real parsing, status mapping and request bodies.
 * Keep an in-memory device table to support mint-then-list flows. */

import { vi } from 'vitest'

import type { PairedDevice, Role } from './types'

export interface RecordedRequest {
  method: string
  url: string
  authorization: string | null
  body: unknown
}

export interface FakeBackendOptions {
  origin?: string
  users?: PairedDevice[]
  /** `false` makes the three owner-only routes answer 403, as a member token does. */
  callerIsOwner?: boolean
  /** The plaintext handed back by a mint. Fixed so a QR assertion is exact. */
  mintedToken?: string
  /** Forces every route to this status, for the unreachable and refusal cases. */
  failWith?: number
  /**
   * Ids whose revoke answers 422, as the server does for the last owner. The
   * status is the same one a bad label gets, which is exactly why the gateway
   * has to name it per call site rather than per status.
   */
  lastOwnerIds?: readonly string[]
}

export interface FakeBackend {
  origin: string
  users: PairedDevice[]
  requests: RecordedRequest[]
  restore: () => void
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function installFakeBackend(options: FakeBackendOptions = {}): FakeBackend {
  const origin = options.origin ?? 'http://192.0.2.10:8000'
  const mintedToken = options.mintedToken ?? 'r4nd0m-t0ken_value'
  const callerIsOwner = options.callerIsOwner ?? true

  const state: FakeBackend = {
    origin,
    users: [...(options.users ?? [])],
    requests: [],
    restore: () => vi.unstubAllGlobals(),
  }

  let minted = 0

  vi.stubGlobal('fetch', async (input: Request | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const raw = await request.clone().text()
    const path = new URL(request.url).pathname

    state.requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get('Authorization'),
      body: raw === '' ? null : JSON.parse(raw),
    })

    if (options.failWith !== undefined) return json({ detail: 'forced' }, options.failWith)
    if (!callerIsOwner) return json({ detail: 'Owner only' }, 403)

    if (request.method === 'GET' && path === '/api/users') {
      return json({ users: state.users }, 200)
    }

    if (request.method === 'POST' && path === '/api/users') {
      const body = JSON.parse(raw) as { label: string; role: Role }
      minted += 1
      const device: PairedDevice = {
        id: `u${minted}`,
        label: body.label,
        role: body.role === 'owner' ? 'owner' : 'member',
        createdAt: '2026-09-01T10:00:00Z',
        lastSeenAt: null,
      }
      state.users.push(device)
      // The shape that matters: the token appears here and in no other
      // response, exactly as the server behaves.
      return json({ user: device, token: mintedToken }, 201)
    }

    if (request.method === 'DELETE' && path.startsWith('/api/users/')) {
      const id = path.slice('/api/users/'.length)
      const found = state.users.find((u) => u.id === id)
      if (found === undefined) return json({ detail: 'Unknown user' }, 404)
      if (options.lastOwnerIds?.includes(id) === true) {
        return json({ detail: 'Cannot revoke the last owner' }, 422)
      }
      state.users = state.users.filter((u) => u.id !== id)
      return json({ success: true, user: found }, 200)
    }

    return json({ detail: 'not found' }, 404)
  })

  return state
}
