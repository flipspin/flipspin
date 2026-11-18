/** Share address probes between onboarding and Settings. Compare instanceId
 * so an answering router or another server cannot count as a successful connection.
 * Key verdicts by URL so editing an address discards its previous result. */
import { useCallback, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { bridge } from '../bridge'
import { apiGet, apiPut, isApiError, queryKeys, serverDetail, useServerHandshake, type ApiData, type ApiError } from '../data'
import { msg } from '../i18n'
import { probeVerdict, reach, type ExternalUrlError, type ProbeVerdict, type Reach, type ReachInput, type Route } from './rules'
export type { Reach } from './rules'

/** The generated `ServerNetworkResponse`. */
export type ServerNetwork = ApiData<'/api/server/network', 'get'>

export type RowKind = 'lan' | 'tailscale' | 'domain'
export type RowState = ProbeVerdict | 'busy' | null

export interface AddressRow {
  kind: RowKind
  /** A `msg()` key: "Local address" · "Tailscale" · "Domain". */
  label: string
  /** What the row shows: the tailnet name when there is one (its URL is the tooltip). */
  shown: string
  /** What `/api/status` is asked at, and what "Copy" copies. */
  url: string
}

export const ROW_LABEL: Record<RowKind, string> = {
  lan: msg("Local address"),
  tailscale: msg('Tailscale'),
  domain: msg("Domain"),
}

export const VERDICT_WORD: Record<ProbeVerdict, string> = {
  'same-nest': msg("Connected_masculine"),
  'other-nest': msg("Another nest answers"),
  'not-krobi': msg("Not a {{app}} nest"),
  unreachable: msg("No answer"),
}

/** "Accesible desde fuera" · "Sin acceso desde fuera" · "Local network only" · "Sin comprobar". */
export const REACH_WORD: Record<Reach, string> = {
  ok: msg("Reachable from outside"),
  bad: msg("Not reachable from outside"),
  local: msg("Local network only"),
  none: msg("Not checked"),
}

/** The rows, in the contract's `pick` order: local first, then Tailscale, then the domain. */
export function addressRows(network: ServerNetwork | null | undefined, domain: string | null): AddressRow[] {
  if (!network) return []
  const rows: AddressRow[] = network.lan.map((url) => ({ kind: 'lan', label: ROW_LABEL.lan, shown: url, url }))
  if (network.tailscale) {
    const { name, url } = network.tailscale
    rows.push({ kind: 'tailscale', label: ROW_LABEL.tailscale, shown: name ?? url, url })
  }
  const external = domain ?? network.externalUrl
  if (external) rows.push({ kind: 'domain', label: ROW_LABEL.domain, shown: external, url: external })
  return rows
}

/** Compare an address's handshake with the expected server identity. */
export async function probeAddress(url: string, instanceId: string): Promise<ProbeVerdict> {
  try {
    const answer = await bridge().invoke('server:probe', { address: url })
    if (answer.ok) return probeVerdict(instanceId, answer.handshake as unknown as Record<string, unknown>)
    return 'reason' in answer && answer.reason === 'not-our-server' ? 'not-krobi' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}

/** The first `lan` address as `host:port`, for the Caddyfile. */
export function lanHostPort(network: ServerNetwork | null | undefined): string {
  const first = network?.lan[0]
  if (!first) return '192.168.1.20:8000'
  return first.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

export interface NestAddresses {
  instanceId: string
  network: ServerNetwork | null
  loading: boolean
  error: ApiError | null
  rows: AddressRow[]
  /** The verdict for a probed URL; null before "Check". */
  stateOf: (url: string) => RowState
  checking: boolean
  /** Probe every row (or only the URLs given). */
  check: (only?: string[]) => Promise<void>
  /** Read `/api/server/network` again ("Volver a buscar"). */
  refresh: () => Promise<void>
}

/**
 * @param domain a typed-but-unsaved domain (already normalised) to list and
 *   probe in place of the saved one; `undefined` lists the saved one.
 */
export function useNestAddresses(domain?: string | null, enabled = true): NestAddresses {
  const queryClient = useQueryClient()
  const handshake = useServerHandshake(enabled)
  const instanceId = handshake.data?.instanceId ?? ''
  const query = useQuery<ServerNetwork, ApiError>({
    queryKey: queryKeys.server.network(),
    enabled,
    queryFn: ({ signal }) => apiGet('/api/server/network', { signal }),
    staleTime: 60_000,
  })
  const [states, setStates] = useState<Record<string, RowState>>({})

  const rows = useMemo(() => addressRows(query.data, domain === undefined ? null : domain), [query.data, domain])

  const check = useCallback(
    async (only?: string[]) => {
      const targets = only ?? rows.map((row) => row.url)
      if (targets.length === 0) return
      setStates((prev) => ({ ...prev, ...Object.fromEntries(targets.map((url) => [url, 'busy' as const])) }))
      await Promise.all(
        targets.map(async (url) => {
          const verdict = await probeAddress(url, instanceId)
          setStates((prev) => ({ ...prev, [url]: verdict }))
        }),
      )
    },
    [rows, instanceId],
  )

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.server.network() })
  }, [queryClient])

  return {
    instanceId,
    network: query.data ?? null,
    loading: query.isPending,
    error: query.error ?? null,
    rows,
    stateOf: (url) => states[url] ?? null,
    checking: Object.values(states).includes('busy'),
    check,
    refresh,
  }
}

/** A remembered check is valid only for this nest and this remote configuration. */
export function reachKey(network: ServerNetwork | null, instanceId: string): string {
  return JSON.stringify([instanceId, network?.route, network?.tailscale?.url, network?.externalUrl, network?.outside])
}

/** Adapt wire timestamps and busy UI states to the pure contract rule. */
export function networkReach(network: ServerNetwork | null, stateOf: (url: string) => RowState = () => null, route?: Route, domain?: string | null) {
  const verdict = (url: string | null | undefined): ProbeVerdict | null => {
    const state = url ? stateOf(url) : null
    return state === 'busy' ? null : state
  }
  const input: ReachInput = {
    route: route ?? network?.route ?? null,
    outside: network?.outside ? { via: network.outside.via, ago: Math.max(0, (Date.now() - Date.parse(network.outside.at)) / 1000) } : null,
    tailscale: !!network?.tailscale,
    domain: !!(domain ?? network?.externalUrl),
    verdicts: { tailscale: verdict(network?.tailscale?.url), domain: verdict(domain ?? network?.externalUrl) },
  }
  return reach(input)
}

export async function saveRemoteRoute(route: Route): Promise<void> {
  try {
    await apiPut('/api/server/remote-route', { body: { route } })
  } catch {
    throw new Error(msg("Could not save remote access."))
  }
}

/** The contract's reason codes, as the field says them. */
export const EXTERNAL_URL_ERROR: Record<ExternalUrlError, string> = {
  'needs-https': msg("Use https://"),
  'has-path': msg("Just the domain, no path"),
  'has-credentials': msg("No username or password"),
  'not-a-url': msg("Not an address"),
}

/**
 * `PUT /api/server/external-url`. Resolves to the stored URL, or rejects with a
 * `msg()` key: the 422's reason code mapped, else a generic failure.
 */
export async function saveExternalUrl(url: string | null): Promise<string | null> {
  try {
    const body = await apiPut('/api/server/external-url', { body: { url } })
    return body.externalUrl
  } catch (error) {
    const code = isApiError(error) && error.status === 422 ? serverDetail(error) : null
    if (code && code in EXTERNAL_URL_ERROR) throw new Error(EXTERNAL_URL_ERROR[code as ExternalUrlError])
    if (isApiError(error) && error.status === 403) throw new Error(msg("Only an admin account can change the domain."))
    throw new Error(msg("Couldn't save the domain."))
  }
}
