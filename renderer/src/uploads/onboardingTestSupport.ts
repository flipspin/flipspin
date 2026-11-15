/** Only server and shell boundaries are faked; screens use the real upload store. */
import { bridge, setFakeBridgeForTest } from '../bridge'
import type { IpcEventPayload, KrobiBridge, UploadBatch, UploadItem } from '../lib/ipc'
import { installFakeSettings, serverStatus, type RecordedInvoke, type RecordedRequest, type ResponseSpec } from '../settings/test-support'

export function uploadFile(index: number, overrides: Partial<UploadItem> = {}): UploadItem {
  return { id: String(index), name: `Song ${index}.flac`, sha256: String(index), bytes: 1_000_000, offset: 0, state: 'por-subir', reason: null, duplicate: false, ...overrides }
}
export function uploadBatch(count = 26, overrides: Partial<UploadBatch> = {}): UploadBatch {
  return { folder: '~/Music/Library', id: 'upload-test', phase: 'resumen', files: Array.from({ length: count }, (_, index) => uploadFile(index)), keepAwake: true, ...overrides }
}
export function installMusicBoundary(options: {
  batch?: UploadBatch | null; restored?: UploadBatch; songs?: number; freeBytes?: number; floorBytes?: number; helper?: boolean; local?: boolean;
  status?: () => Promise<{ batches: UploadBatch[] }>;
  respond?: (request: RecordedRequest) => ResponseSpec | undefined
} = {}) {
  let keepAwake = true
  let current = options.batch === undefined ? uploadBatch() : options.batch
  const invocations: RecordedInvoke[] = []
  const listeners = new Map<string, Set<(value: unknown) => void>>()
  const registrations = new Map<string, number>()
  const summary = { folder: '/music', songs: options.songs ?? 0, albums: options.songs ? 3 : 0, artists: options.songs ? 2 : 0 }
  const fake = installFakeSettings({ status: serverStatus({ mode: options.local ? 'child' : 'external' }), respond: request => {
    const custom = options.respond?.(request)
    if (custom) return custom
    switch (request.pathname) {
      case '/api/library/summary': return { status: 200, json: summary }
      case '/api/library/health': return { status: 200, json: { stats: { songs: { state: 'ready', value: summary.songs }, albums: { state: 'ready', value: summary.albums } } } }
      case '/api/listar-albums-con-metadata': return { status: 200, json: [] }
      case '/api/library/scan': return { status: 200, json: { scanning: false, pending: false } }
      case '/api/uploads/space': return { status: 200, json: { freeBytes: options.freeBytes ?? 1e12, floorBytes: options.floorBytes ?? 1e8 } }
      case '/api/compute/summary': return { status: 200, json: { kinds: [], computers: options.helper ? [{ id: 'helper', name: 'Music helper', nest: false, state: 'idle', jobs: ['analysis'] }] : [] } }
      case '/api/analysis/runs/preview': return { status: 200, json: { size: options.songs ?? 0, waiting: options.songs ?? 0 } }
      case '/api/analysis/runs': return { status: 200, json: { id: 'run-test' } }
      case '/api/me': return { status: 200, json: { id: 'member', role: 'member', isOwner: false, source: 'token', onboarded: true } }
      case '/api/me/devices': return { status: 200, json: { devices: [] } }
      case '/api/server/remote-route': return { status: 200, json: request.body }
      case '/api/server/network': return { status: 200, json: { lan: [], tailscale: null, externalUrl: null } }
      default: return undefined
    }
  } })
  const previous = bridge()
  const emit = <K extends 'upload:changed' | 'upload:error' | 'auth:changed'>(channel: K, value: IpcEventPayload<K>) => {
    if (channel === 'upload:changed') current = value as UploadBatch
    for (const listener of listeners.get(channel) ?? []) listener(value)
  }
  const undo = setFakeBridgeForTest({
    invoke: (async (channel: string, request: unknown) => {
      invocations.push({ channel, request })
      switch (channel) {
        case 'upload:status': if (options.status) return options.status(); return { batches: options.restored ? [options.restored] : [] }
        case 'upload:keep-awake': {
          const enabled = (request as { enabled?: boolean }).enabled
          if (enabled != null) { keepAwake = enabled; if (current) current = { ...current, keepAwake: enabled } }
          return { enabled: keepAwake }
        }
        case 'upload:start': {
          if (request && 'id' in (request as object) && current) current = { ...current, phase: 'subiendo' }
          return current
        }
        case 'upload:stop': current = current && { ...current, phase: 'terminado' }; return current
        case 'upload:retry-failed': current = current && { ...current, phase: 'subiendo' }; return current
        default: return previous.invoke(channel as Parameters<KrobiBridge['invoke']>[0], request as never)
      }
    }) as KrobiBridge['invoke'],
    on: ((channel: string, listener: (value: unknown) => void) => {
      if (channel.startsWith('upload:') || channel === 'auth:changed') {
        if (!listeners.has(channel)) listeners.set(channel, new Set())
        registrations.set(channel, (registrations.get(channel) ?? 0) + 1)
        listeners.get(channel)!.add(listener)
        return () => { listeners.get(channel)?.delete(listener) }
      }
      return previous.on(channel as Parameters<KrobiBridge['on']>[0], listener)
    }) as KrobiBridge['on'],
  })
  return { fake, invocations, emit, registrations, summary, listenerCount: (channel: string) => listeners.get(channel)?.size ?? 0, restore: () => { undo(); fake.restore() } }
}
