/**
 * The nest as Settings draws it everywhere; the menu foot, "Overview", "Status":
 * reachable or not (the handshake answered), its name and version, and the
 * address this app talks to.
 */
import { useServerHandshake } from '../data'
import { msg } from '../i18n'
import type { ServerStatus } from '../lib/ipc'
import type { InstallState } from './useInstall'
import type { Tone } from './parts'
import { useConfig } from './config'
import { bareHost } from './format'

export interface NestView {
  kind: 'loading' | 'online' | 'offline' | 'restarting'
  name: string | null
  version: string | null
  instanceId: string | null
  /** host:port, without the scheme. */
  address: string
  /** When the handshake last answered (ms), for "comprobado hace…". */
  checkedAt: number
  retry: () => void
}

export function addressOf(server: InstallState<ServerStatus | null>): string {
  if (server.kind !== 'ready' || server.value === null) return ''
  return bareHost(server.value.via ?? server.value.baseUrl)
}

export function useNest(server: InstallState<ServerStatus | null>): NestView {
  const handshake = useServerHandshake()
  const data = handshake.data
  const { restarting } = useConfig()
  const kind = restarting ? 'restarting' : handshake.isPending ? 'loading' : handshake.isError ? 'offline' : 'online'
  return {
    kind,
    name: data?.name ?? null,
    version: data?.version ?? null,
    instanceId: data?.instanceId ?? null,
    address: addressOf(server),
    checkedAt: handshake.dataUpdatedAt,
    retry: () => void handshake.refetch(),
  }
}

/** The state word (a `msg()` key) and its tone. */
export function nestWord(kind: NestView['kind']): { word: string; tone: Tone } {
  if (kind === 'restarting') return { word: msg("Restarting the nest…"), tone: 'none' }
  if (kind === 'online') return { word: msg("Online"), tone: 'ok' }
  if (kind === 'offline') return { word: msg("No answer"), tone: 'bad' }
  return { word: msg("Searching…"), tone: 'none' }
}
