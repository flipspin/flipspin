/**
 * What Settings reads from the nest, as cached queries: a section switch or a
 * return to "Overview" draws from the cache instead of asking again, and the
 * index rows on "Overview" read the very same entries the sections do.
 *
 * Everything goes through the data layer's door (`apiGet` and friends). The
 * routes are typed from the schema and older responses are narrowed here.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import { apiGet, isApiError, queryKeys, type ApiData, type ApiError } from '../data'
import { createHouseholdGateway, listMyDevices, readLog, type LogFile, type LogPage, type MyDevice } from './gateways'
import { readDeviceList } from '../pairing/gateway'
import type { PairedDevice } from '../pairing'

export type ServerStorage = ApiData<'/api/server/storage', 'get'>
export type LibrarySummary = ApiData<'/api/library/summary', 'get'>

/** A nest older than the route answers FastAPI's stock 404 (or 405). */
export function isOlderNest(error: unknown): boolean {
  if (!isApiError(error)) return false
  if (error.status === 405) return true
  if (error.status !== 404) return false
  const body = error.body
  return typeof body === 'object' && body !== null && (body as { detail?: unknown }).detail === 'Not Found'
}

export function useServerStorage(enabled: boolean): UseQueryResult<ServerStorage, ApiError> {
  return useQuery<ServerStorage, ApiError>({
    queryKey: queryKeys.server.storage(),
    queryFn: ({ signal }) => apiGet('/api/server/storage', { signal }),
    enabled,
    staleTime: 5 * 60_000,
  })
}

export function useLibrarySummary(enabled = true): UseQueryResult<LibrarySummary, ApiError> {
  return useQuery<LibrarySummary, ApiError>({
    queryKey: queryKeys.library.summary(),
    queryFn: ({ signal }) => apiGet('/api/library/summary', { signal }),
    enabled,
    staleTime: 60_000,
  })
}

const household = createHouseholdGateway()

/** `GET /api/users`; every account, through the pairing feature's gateway. */
export function useAccounts(enabled: boolean): UseQueryResult<PairedDevice[], unknown> {
  return useQuery<PairedDevice[], unknown>({
    queryKey: queryKeys.household.users(),
    queryFn: async ({ signal }) => readDeviceList(await apiGet('/api/users', { signal })),
    enabled,
    staleTime: 60_000,
  })
}

export function householdGateway() {
  return household
}

export function useMyDevices(enabled: boolean): UseQueryResult<MyDevice[], ApiError> {
  return useQuery<MyDevice[], ApiError>({
    queryKey: queryKeys.me.devices(),
    queryFn: ({ signal }) => listMyDevices(signal),
    enabled,
    staleTime: 60_000,
  })
}

/* ───────────────────────────── providers ───────────────────────────── */

export interface Provider {
  id: string
  kind: string
  name: string
  enabled: boolean
  position: number
  available: boolean
  requiresCredentials: boolean
  capabilities: string[]
  unavailableReason: string | null
  health?: ApiData<'/api/providers', 'get'>['providers'][number]['health']
  format?: ApiData<'/api/providers', 'get'>['providers'][number]['format']
  status?: ApiData<'/api/providers', 'get'>['providers'][number]['status']
}

/** Keep older nests and optional provider extensions readable. */
export function toProvider(raw: unknown, index: number): Provider | null {
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : ''
  if (id === '') return null
  return {
    id,
    kind: typeof row.kind === 'string' ? row.kind : 'otros',
    name: typeof row.name === 'string' && row.name ? row.name : id,
    enabled: row.enabled !== false,
    position: typeof row.position === 'number' ? row.position : index,
    available: row.available !== false,
    requiresCredentials: row.requiresCredentials === true,
    capabilities: Array.isArray(row.capabilities) ? row.capabilities.filter((c): c is string => typeof c === 'string') : [],
    health: typeof row.health === 'object' && row.health !== null && 'state' in row.health ? row.health as Provider['health'] : undefined,
    format: typeof row.format === 'object' && row.format !== null && 'codec' in row.format ? row.format as Provider['format'] : undefined,
    status: typeof row.status === 'object' && row.status !== null ? row.status as Provider['status'] : undefined,
    unavailableReason: typeof row.unavailableReason === 'string' && row.unavailableReason.trim() ? row.unavailableReason : null,
  }
}

export function readProviders(body: unknown): Provider[] {
  const list = typeof body === 'object' && body !== null ? (body as { providers?: unknown }).providers : null
  if (!Array.isArray(list)) return []
  return list.map(toProvider).filter((p): p is Provider => p !== null)
}

export function useProviders(enabled: boolean): UseQueryResult<Provider[], ApiError> {
  return useQuery<Provider[], ApiError>({
    queryKey: queryKeys.server.providers(),
    queryFn: async ({ signal }) => readProviders(await apiGet('/api/providers', { signal })),
    enabled,
    staleTime: 10_000,
  })
}

/* ───────────────────────────── analysis ───────────────────────────── */

export function useAnalysisTags(enabled: boolean): UseQueryResult<boolean, ApiError> {
  return useQuery<boolean, ApiError>({
    queryKey: queryKeys.server.analysisTags(),
    queryFn: async ({ signal }) => {
      const body = await apiGet('/api/config/analysis-tags', { signal })
      return typeof body === 'object' && body !== null && (body as { write_analysis_tags?: unknown }).write_analysis_tags === true
    },
    enabled,
    staleTime: 60_000,
  })
}

/* ───────────────────────────── logs ───────────────────────────── */

export const LOG_WINDOW = 300

export function useLog(file: LogFile, q: string, enabled: boolean): UseQueryResult<LogPage, ApiError> {
  return useQuery<LogPage, ApiError>({
    networkMode: file === 'desktop' || file === 'helper' ? 'always' : 'online',
    queryKey: queryKeys.server.logs({ file, lines: LOG_WINDOW, q }),
    queryFn: ({ signal }) => readLog({ file, lines: LOG_WINDOW, level: '', q }, signal),
    enabled,
    staleTime: 30_000,
  })
}


export type ServerUpdate = ApiData<'/api/server/update', 'get'>

/** Owners only; an older or refusing nest contributes no update UI. */
export function useServerUpdate(admin: boolean) {
  const query = useQuery<ServerUpdate, ApiError>({
    queryKey: queryKeys.server.update(),
    queryFn: ({ signal }) => apiGet('/api/server/update', { signal }),
    enabled: admin === true,
    retry: false,
    staleTime: 30_000,
  })
  return { ...query, data: admin === true && !query.isError ? query.data : undefined }
}

/** Manifest observations are owner-only; an older nest leaves existing rows usable. */
export function useExtensions(enabled: boolean) {
  const query = useQuery<ApiData<'/api/extensions', 'get'>, ApiError>({
    queryKey: queryKeys.server.extensions(),
    queryFn: ({ signal }) => apiGet('/api/extensions', { signal }),
    enabled,
    retry: false,
    staleTime: 10_000,
  })
  return { ...query, data: enabled && !query.isError ? query.data : undefined }
}
