/** Validate unannotated identity responses before components consume them.
 * Map failures here because the meaning of a 422 depends on the request that produced it. */

import type { ApiClient } from '../api/client'

import { PairingError } from './types'
import type { MintedAccess, PairedDevice, PairingGateway, Role } from './types'

/** Treat unrecognized roles as member, matching the server's fail-closed normalization. */
function readRole(value: unknown): Role {
  return value === 'owner' ? 'owner' : 'member'
}

function readDevice(value: unknown): PairedDevice {
  if (typeof value !== 'object' || value === null) {
    throw new PairingError('malformed', 'user row was not an object')
  }
  const row = value as Record<string, unknown>
  const { id, label, createdAt, lastSeenAt } = row
  if (typeof id !== 'string' || typeof label !== 'string' || typeof createdAt !== 'string') {
    throw new PairingError('malformed', 'user row is missing id, label or createdAt')
  }
  return {
    id,
    label,
    role: readRole(row.role),
    createdAt,
    lastSeenAt: typeof lastSeenAt === 'string' ? lastSeenAt : null,
  }
}

export function readDeviceList(body: unknown): PairedDevice[] {
  const users = (body as Record<string, unknown> | null | undefined)?.users
  if (!Array.isArray(users)) {
    throw new PairingError('malformed', 'response had no users array')
  }
  return users.map(readDevice)
}

/**
 * Turns a non-2xx response into a named failure.
 *
 * `unprocessable` is what a 422 should be called *at this call site*; the
 * caller passes it, because the same status means "the last owner" on a revoke
 * and "that label or role" on a mint.
 */
function failureFor(status: number, unprocessable: PairingError['kind']): PairingError {
  if (status === 403) return new PairingError('forbidden', 'owner-only route refused this token')
  if (status === 404) return new PairingError('missing', 'no such user')
  if (status === 422) return new PairingError(unprocessable, 'server refused the request')
  return new PairingError('unreachable', `unexpected status ${status}`)
}

/** Map rejected fetches to network failures, but preserve AbortError so unmounts remain silent. */
async function attempt<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (cause) {
    if (cause instanceof PairingError) throw cause
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new PairingError('unreachable', 'the request did not reach the server')
  }
}

/**
 * Nothing in here may put a token in an error. A thrown `PairingError` can end
 * up in a console, a crash report, or a bug report screenshot; the minted token
 * exists for one render and must not travel with an exception.
 */
export function createPairingGateway(client: ApiClient): PairingGateway {
  return {
    listDevices: (signal) =>
      attempt(async () => {
        const { data, response } = await client.GET('/api/users', { signal })
        if (!response.ok) throw failureFor(response.status, 'rejected')
        return readDeviceList(data)
      }),

    mintDevice: ({ label, role, username, password }, signal) =>
      attempt(async () => {
        const { data, response } = await client.POST('/api/users', {
          body: { label, role, ...(username && password ? { username, password } : {}) },
          signal,
        })
        if (response.status === 409) throw new PairingError('taken', 'that username is taken')
        if (!response.ok) throw failureFor(response.status, 'rejected')
        const body = data as Record<string, unknown> | undefined
        const token = body?.token
        if (typeof token !== 'string' || token === '') {
          // Worth its own failure rather than an empty string in the dialog: the
          // row exists on the server at this point, so the person has an access
          // they cannot use and must revoke it by hand. Saying "malformed" is
          // the only way that reaches them at all.
          throw new PairingError('malformed', 'mint response carried no token')
        }
        return { device: readDevice(body?.user), token } satisfies MintedAccess
      }),

    revokeDevice: (id, signal) =>
      attempt(async () => {
        const { response } = await client.DELETE('/api/users/{user_id}', {
          params: { path: { user_id: id } },
          signal,
        })
        if (!response.ok) throw failureFor(response.status, 'lastOwner')
      }),
  }
}
