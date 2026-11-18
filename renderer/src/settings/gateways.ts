/**
 * Adapts account and device operations to the shared HTTP and native boundaries.
 * Use the data layer for normalized failures, preserved status codes and abort handling.
 * Derive response types from the generated schema; narrow unannotated bodies at runtime.
 * Delegate pairing operations to the pairing gateway and resolve its client per call.
 * Native-only operations go through the typed bridge.
 */
import { bridge } from '../bridge'
import type { LocalLogPage } from '../lib/ipc'

import { apiDelete, apiGet, apiPatch, apiPost, getApiClient, type ApiData } from '../data'
import { createPairingGateway } from '../pairing'
import type { PairedDevice, PairingGateway } from '../pairing'

/* ─────────────────────────── The household: /api/users ─────────────────── */

/** Delegate identity parsing and status mapping to the pairing gateway.
 * Resolve the memoized client per call because its origin comes from the native bridge. */
export function createHouseholdGateway(): PairingGateway {
  const delegate = async (): Promise<PairingGateway> => createPairingGateway(await getApiClient())
  return {
    listDevices: async (signal) => (await delegate()).listDevices(signal),
    mintDevice: async (input, signal) => (await delegate()).mintDevice(input, signal),
    revokeDevice: async (id, signal) => (await delegate()).revokeDevice(id, signal),
  }
}

/* ───────────────────────── My own devices: /api/me/devices ─────────────── */

/** Roles belong to accounts, not individual devices. */
export interface MyDevice {
  id: string
  label: string
  createdAt: string | null
  lastSeenAt: string | null
  /** The credential this very request arrived with. Exactly one row, or none. */
  isCurrent: boolean
  credentialType?: 'app-password' | 'api-key' | null
  firstSubsonicRequestAt?: string | null
  lastSubsonicRequestAt?: string | null
  subsonicClientName?: string | null
  lastSubsonicFailureAt?: string | null
  lastSubsonicFailure?: 'wrong-mechanism' | null
}

export function isMusicApp(device: MyDevice): boolean {
  return Boolean(device.credentialType || device.firstSubsonicRequestAt)
}

export interface MintedDevice {
  device: MyDevice
  /** The only moment this value exists. Never persisted, logged or re-fetched. */
  token: string
}

/** One row of a `DeviceListResponse`, as both device routes publish it. */
function toDevice(row: ApiData<'/api/me/devices', 'get'>['devices'][number]): MyDevice {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.createdAt ?? null,
    lastSeenAt: row.lastSeenAt ?? null,
    isCurrent: row.isCurrent,
    credentialType: row.credentialType,
    firstSubsonicRequestAt: row.firstSubsonicRequestAt,
    lastSubsonicRequestAt: row.lastSubsonicRequestAt,
    subsonicClientName: row.subsonicClientName,
    lastSubsonicFailureAt: row.lastSubsonicFailureAt,
    lastSubsonicFailure: row.lastSubsonicFailure,
  }
}

export async function listMyDevices(signal?: AbortSignal): Promise<MyDevice[]> {
  const body = await apiGet('/api/me/devices', { signal })
  return body.devices.filter(isPersonalDevice).map(toDevice)
}

// Older nests omit the flag; keep their historical helpers out of both lists.
function isPersonalDevice(row: ApiData<'/api/me/devices', 'get'>['devices'][number]): boolean {
  return row.helper !== true && !(row.helper == null && row.label.endsWith(' · trabajador'))
}

export async function renameMyDevice(id: string, label: string): Promise<MyDevice> {
  return toDevice(await apiPatch('/api/me/devices/{device_id}', {
    params: { path: { device_id: id } },
    body: { label },
  }))
}

export async function addMyDevice(label: string, signal?: AbortSignal): Promise<MintedDevice> {
  const body = await apiPost('/api/me/devices', { body: { label }, signal })
  return {
    device: {
      id: body.device.id,
      label: body.device.label,
      createdAt: body.device.createdAt ?? null,
      lastSeenAt: body.device.lastSeenAt ?? null,
      // Freshly minted and not yet used: it cannot be the credential this
      // request arrived with, and the list route would say so too.
      isCurrent: false,
    },
    token: body.token,
  }
}

/**
 * A device whose token is a typeable app password, for a Subsonic client
 * (`POST /api/me/devices/app-password`, docs/features/opensubsonic.md).
 * Listed and revoked like any other device; the password is shown once.
 */
export async function addAppPassword(label: string, signal?: AbortSignal): Promise<MintedDevice> {
  const body = await apiPost('/api/me/devices/app-password', { body: { label }, signal })
  return {
    device: {
      id: body.device.id,
      label: body.device.label,
      createdAt: body.device.createdAt ?? null,
      lastSeenAt: body.device.lastSeenAt ?? null,
      isCurrent: false,
    },
    token: body.token,
  }
}

/** OpenSubsonic apiKey: only a SHA-256 verifier is stored by the nest. */
export async function addSubsonicApiKey(label: string, signal?: AbortSignal): Promise<MintedDevice> {
  const body = await apiPost('/api/me/devices/api-key', { body: { label }, signal })
  return {
    device: {
      id: body.device.id,
      label: body.device.label,
      createdAt: body.device.createdAt ?? null,
      lastSeenAt: body.device.lastSeenAt ?? null,
      isCurrent: false,
    },
    token: body.token,
  }
}

/** Report self-revocation so the client treats subsequent 401s as sign-out rather than a server fault. */
export async function revokeMyDevice(id: string, signal?: AbortSignal): Promise<{ signedOutThisDevice: boolean }> {
  const body = await apiDelete('/api/me/devices/{device_id}', {
    params: { path: { device_id: id } },
    signal,
  })
  return { signedOutThisDevice: body.signedOutThisDevice }
}

/* ─────────────── One account's devices: /api/users/{id}/devices ──────────── */

/** Fetch account devices only when expanded; /api/users retains its shipped row shape.
 * isCurrent can be true only for the caller's own device.
 * Older servers return the stock 404; distinguish it from a removed account. */
export async function listAccountDevices(userId: string, signal?: AbortSignal): Promise<MyDevice[]> {
  const body = await apiGet('/api/users/{user_id}/devices', {
    params: { path: { user_id: userId } },
    signal,
  })
  return body.devices.filter(isPersonalDevice).map(toDevice)
}

/* ───────────────────── The household name: /api/users/{id}/label ─────────── */

/** Rename the public account label without changing its sign-in username or device labels.
 * Return the updated row so the list can refresh it without another request. */
export async function renameAccount(userId: string, label: string, signal?: AbortSignal): Promise<PairedDevice> {
  const body = await apiPost('/api/users/{user_id}/label', {
    params: { path: { user_id: userId } },
    body: { label },
    signal,
  })
  return toPerson(body.user)
}

/** A `UserPublic` row as the pairing feature already models it. */
function toPerson(row: {
  id: string
  label: string
  role: string
  createdAt?: string | null
  lastSeenAt?: string | null
}): PairedDevice {
  return {
    id: row.id,
    label: row.label,
    role: row.role === 'owner' ? 'owner' : 'member',
    createdAt: row.createdAt ?? '',
    lastSeenAt: row.lastSeenAt ?? null,
  }
}

/* ─────────────────────────── The password: /api/me/password ────────────── */

export interface PasswordChanged {
  /** Read the server's session outcome: changing a password does not revoke device tokens. */
  otherDevicesSignedOut: boolean
  /** How many credentials still work. The number the reassurance is about. */
  deviceCount: number
}

export async function changeMyPassword(
  input: { currentPassword: string | null; newPassword: string },
  signal?: AbortSignal,
): Promise<PasswordChanged> {
  const body = await apiPost('/api/me/password', {
    body: { currentPassword: input.currentPassword, newPassword: input.newPassword },
    signal,
  })
  return { otherDevicesSignedOut: body.otherDevicesSignedOut, deviceCount: body.deviceCount }
}

/* ─────────────────────────────── The log: /api/logs ────────────────────── */

/** Which log. A key the backend allowlists, never a path; see its own route. */
export type LogFile = 'errors' | 'app' | 'desktop' | 'helper'

export async function clearLog(file: LogFile): Promise<void> {
  if (file === 'desktop' || file === 'helper') {
    await bridge().invoke('log:clear', { source: file })
  } else {
    await apiPost('/api/logs/clear', { body: { file } })
  }
}

export type LogPage = LocalLogPage

export interface LogQuery {
  file: LogFile
  lines: number
  level: string
  q: string
}

/** Validate log responses and default optional fields so older servers can still display their logs. */
export async function readLog(query: LogQuery, signal?: AbortSignal): Promise<LogPage> {
  if (query.file === 'desktop' || query.file === 'helper') {
    return bridge().invoke('log:read', { source: query.file, lines: query.lines, q: query.q })
  }
  const body = await apiGet('/api/logs', {
    params: {
      query: {
        file: query.file,
        lines: query.lines,
        // Empty means "no filter" to this backend, and sending the empty string
        // is what its default already is; so it is sent rather than omitted, to
        // keep one shape of request instead of four.
        level: query.level,
        q: query.q,
      },
    },
    signal,
  })
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const lines = Array.isArray(record.lines) ? record.lines.filter((line): line is string => typeof line === 'string') : []
  return {
    path: typeof record.path === 'string' ? record.path : '',
    lines,
    truncated: record.truncated === true,
    sizeBytes: typeof record.sizeBytes === 'number' ? record.sizeBytes : 0,
    matched: typeof record.matched === 'number' ? record.matched : lines.length,
    scanned: typeof record.scanned === 'number' ? record.scanned : 0,
  }
}
