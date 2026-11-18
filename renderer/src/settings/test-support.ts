/** Fake the network and bridge boundaries so tests exercise production gateways and IPC contracts.
 * Restore the bridge through setFakeBridgeForTest's undo function to avoid leaking state. */

import type { AuthIdentity, DiscoveredNest, IpcInvokeContract, IpcEventPayload, KrobiBridge, LoginItemState, MacEngineStatus, ServerStatus, SnapshotKind, LibrarySnapshot } from '../lib/ipc'

import { setFakeBridgeForTest } from '../bridge'
import { resetApiClient } from '../data'

export interface RecordedRequest {
  method: string
  url: string
  pathname: string
  search: string
  /** The parsed JSON body, or null when there was none. */
  body: unknown
}

export type ResponseSpec =
  | { status: number; json?: unknown; text?: string }
  /** No answer at all: the server is down, the cable is out, the VPN dropped. */
  | { networkError: string }

export interface RecordedInvoke {
  channel: string
  request: unknown
}

export interface FakeSettingsOptions {
  localLogs?: {
    helper: boolean
    read: (request: IpcInvokeContract['log:read']['request']) => IpcInvokeContract['log:read']['response']
  }
  session?: IpcInvokeContract['credentials:describe']['response']
  saveSession?: () => IpcInvokeContract['credentials:save-to-file']['response']
  saveKeyExport?: (request: IpcInvokeContract['files:save-key-export']['request']) => IpcInvokeContract['files:save-key-export']['response']
  snapshot?: (kind: SnapshotKind) => LibrarySnapshot | null | undefined | Promise<LibrarySnapshot | null | undefined>
  forcedOffline?: boolean
  macEngine?: MacEngineStatus
  installEngine?: (target: 'engine' | 'lyrics' | 'stems' | 'analysis') => IpcInvokeContract['lyrics:engine-install']['response']
  repairEngine?: () => IpcInvokeContract['lyrics:engine-repair']['response']
  loginItem?: LoginItemState
  setLoginItem?: (enabled: boolean) => LoginItemState
  origin?: string
  /** What `server:get-status` answers. `null` means "no server configured". */
  status?: ServerStatus | null
  identity?: Partial<AuthIdentity>
  probe?: (address: string) => IpcInvokeContract['server:probe']['response']
  use?: (address: string | null) => IpcInvokeContract['server:use']['response']
  /** What `server:discover` finds on the LAN. Default: nothing. */
  nests?: DiscoveredNest[]
  /** What `app:get-device-name` answers. */
  deviceName?: string
  /** What `server:local-setup-token` answers. */
  localSetupToken?: string | null
  /** Answers a request. Returning nothing produces a 404, like a real server. */
  respond?: (request: RecordedRequest) => ResponseSpec | undefined
  /** `offline:sync` rejects with this message (a stale snapshot, say). */
  syncFails?: string
}

export interface FakeSettings {
  origin: string
  /** Every request that reached the network, in order. */
  requests: RecordedRequest[]
  /** Every IPC call that crossed the bridge, in order. */
  invocations: RecordedInvoke[]
  invokedWith: (channel: string) => unknown[]
  emitEngineProgress: (progress: IpcEventPayload<'lyrics:engine-progress'>) => void
  emitServerStatus: (status: ServerStatus) => void
  emitFocus: (focused: boolean) => void
  restore: () => void
}

/** A reachable, app-started server. Override only the field a test is about. */
export function serverStatus(overrides: Partial<ServerStatus> = {}): ServerStatus {
  return {
    connection: { state: overrides.mode === 'unchosen' ? 'unchosen' : overrides.starting ? 'connecting' : overrides.reachable === false ? 'unreachable' : 'connected', since: 0, attempt: 1, lastError: null, checks: [] },
    mode: 'child',
    baseUrl: 'http://127.0.0.1:8000',
    port: 8000,
    pid: 4242,
    instanceId: 'lib-1',
    name: null,
    identified: true,
    reachable: true,
    adopted: false,
    ownedByUs: true,
    problem: null,
    starting: false,
    lanUrl: null,
    ...overrides,
  }
}

export function installFakeSettings(options: FakeSettingsOptions = {}): FakeSettings {
  const origin = options.origin ?? 'http://192.0.2.10:8000'
  const requests: RecordedRequest[] = []
  const invocations: RecordedInvoke[] = []
  const progressListeners: ((progress: IpcEventPayload<'lyrics:engine-progress'>) => void)[] = []
  const authListeners: ((identity: AuthIdentity) => void)[] = []
  const focusListeners: ((focused: boolean) => void)[] = []
  const serverListeners: ((status: ServerStatus) => void)[] = []

  let identity: AuthIdentity = {
    userId: 'u-me',
    label: 'Escritorio',
    role: 'owner',
    hasToken: true,
    ...options.identity,
  }

  const previousFetch = globalThis.fetch

  globalThis.fetch = (async (input: unknown): Promise<Response> => {
    // A real fetch rejects on an already-aborted signal and never touches the
    // network. A fake that ignored it would let a test "prove" cancellation
    // handling against a request that was never cancelled.
    const request = input as Request
    if (request.signal?.aborted === true) throw abortError()

    const url = new URL(typeof input === 'string' ? input : request.url)
    const raw = typeof input === 'string' ? '' : await request.clone().text()
    const recorded: RecordedRequest = {
      method: typeof input === 'string' ? 'GET' : request.method,
      url: url.toString(),
      pathname: url.pathname,
      search: url.search,
      body: raw === '' ? null : JSON.parse(raw),
    }
    requests.push(recorded)

    const spec = options.respond?.(recorded) ?? { status: 404, json: { detail: 'Not Found' } }
    if ('networkError' in spec) {
      // A failed fetch rejects with a TypeError; matching the platform matters
      // because the code under test branches on what it caught.
      throw new TypeError(spec.networkError)
    }

    const body = spec.text ?? (spec.json === undefined ? '' : JSON.stringify(spec.json))
    return new Response(body === '' ? null : body, {
      status: spec.status,
      statusText: STATUS_TEXT[spec.status] ?? '',
      headers: { 'content-type': spec.text === undefined ? 'application/json' : 'text/plain' },
    })
  }) as typeof globalThis.fetch

  const fake: KrobiBridge = {
    invoke: (async (channel: string, request: unknown) => {
      invocations.push({ channel, request })
      switch (channel) {
        case 'headers:get': return []
        case 'headers:set': return (request as IpcInvokeContract['headers:set']['request']).headers.map(row => ({ name: row.name, set: true }))
        case 'credentials:describe': return options.session ?? {
          store: 'macos-keychain', reason: null, nest: { name: 'Nido de prueba', address: origin },
          deviceName: 'Equipo de prueba', linkedAt: null, lastUsed: null, state: 'activa',
        }
        case 'credentials:save-to-file': {
          const result = options.saveSession?.() ?? { ok: true, store: 'file' }
          if (result.ok && options.session) options.session = { ...options.session, store: 'file', reason: null }
          return result
        }
        case 'files:save-key-export': return options.saveKeyExport?.(request as IpcInvokeContract['files:save-key-export']['request']) ?? { ok: true, cancelled: false }
        case 'offline:sync':
          if (options.syncFails) throw new Error(options.syncFails)
          return { ok: true }
        case 'offline:snapshot': return options.snapshot?.((request as { kind: SnapshotKind }).kind)
        case 'offline:mode': {
          const forced = (request as { forced?: boolean })?.forced
          if (forced !== undefined) options.forcedOffline = forced
          return { forced: options.forcedOffline ?? false }
        }
        case 'offline:outbox': return []
        case 'offline:status': return { tracks: [], pins: 0, files: 0, bytes: 0 }
        case 'system:login-item-get':
          return options.loginItem ?? { supported: true, enabled: false, status: 'disabled' }
        case 'system:login-item-set': {
          const enabled = (request as { enabled: boolean }).enabled
          options.loginItem = options.setLoginItem?.(enabled) ?? { supported: true, enabled, status: enabled ? 'enabled' : 'disabled' }
          return options.loginItem
        }
        case 'lyrics:engine-status':
          return options.macEngine ?? { supported: false, installed: false, agentRunning: false, installing: null, installError: null, uv: false, workerSource: null, toolsDir: '', modelsDir: '' }
        case 'lyrics:engine-install':
          return options.installEngine?.((request as { target?: 'engine' | 'lyrics' | 'stems' })?.target ?? 'engine') ?? { started: true }
        case 'lyrics:engine-remove':
          return { ok: true }
        case 'lyrics:engine-repair':
          return options.repairEngine?.() ?? { started: true }
        case 'lyrics:worker-set':
          if (options.macEngine) options.macEngine.enabled = (request as { enabled: boolean }).enabled
          return { ok: true }
        case 'lyrics:worker-configure':
          if (options.macEngine && 'tray' in (request as object)) options.macEngine.tray = (request as { tray: boolean }).tray
          return { ok: true }
        case 'app:get-backend-origin':
          return { origin }
        case 'app:get-version':
          return { version: '0.0.0-test' }
        case 'app:get-device-name':
          return { name: options.deviceName ?? 'Mac de prueba' }
        case 'server:discover':
          return { nests: options.nests ?? [] }
        case 'server:local-setup-token':
          return { token: options.localSetupToken ?? null }
        case 'server:get-status':
          return options.status === undefined ? serverStatus({ baseUrl: origin }) : options.status
        case 'server:report-auth':
          options.status = serverStatus({ ...options.status, connection: { state: 'needs-auth', since: 0, attempt: 1, lastError: null, checks: [] } })
          for (const listener of [...serverListeners]) listener(options.status)
          return { ok: true }
        case 'server:retry-now':
          return { ok: true }
        case 'server:probe':
          return (
            options.probe?.((request as { address: string }).address) ?? {
              ok: false as const,
              reason: 'unreachable' as const,
            }
          )
        case 'server:use':
          return options.use?.((request as { address: string | null }).address) ?? { ok: true, relaunching: true }
        case 'auth:get':
          return identity
        case 'auth:clear': {
          // Modelled on what main really does: it clears the credential and
          // then *broadcasts*. The panel is redrawn from the broadcast, so a
          // fake that only answered `{ok:true}` would let a component pass this
          // test while never listening to `auth:changed`.
          identity = { userId: null, label: null, role: null, hasToken: false }
          for (const listener of [...authListeners]) listener(identity)
          return { ok: true }
        }
        case 'log:sources':
          return { helper: options.localLogs?.helper ?? false }
        case 'log:read':
          return options.localLogs?.read(request as IpcInvokeContract['log:read']['request'])
        case 'log:clear':
          return { source: (request as IpcInvokeContract['log:clear']['request']).source, clearedBytes: 100 }
        case 'log:open-folder':
          return { ok: true }
        case 'log:write':
          return undefined
        default:
          throw new Error(`the fake bridge has no handler for ${channel}`)
      }
    }) as KrobiBridge['invoke'],

    on: ((channel: string, listener: (payload: never) => void) => {
      if (channel === 'lyrics:engine-progress') {
        const typed = listener as unknown as (value: IpcEventPayload<'lyrics:engine-progress'>) => void
        progressListeners.push(typed)
        return () => remove(progressListeners, typed)
      }
      if (channel === 'window:focus') {
        const typed = listener as unknown as (focused: boolean) => void
        focusListeners.push(typed)
        return () => remove(focusListeners, typed)
      }
      if (channel === 'auth:changed') {
        const typed = listener as unknown as (value: AuthIdentity) => void
        authListeners.push(typed)
        return () => remove(authListeners, typed)
      }
      if (channel === 'server:status-changed') {
        const typed = listener as unknown as (value: ServerStatus) => void
        serverListeners.push(typed)
        return () => remove(serverListeners, typed)
      }
      return () => {}
    }) as KrobiBridge['on'],
  }

  const removeBridge = setFakeBridgeForTest(fake)

  // Reset the memoized client so tests cannot inherit another fixture's origin.
  resetApiClient()

  return {
    origin,
    requests,
    invocations,
    invokedWith: (channel) => invocations.filter((entry) => entry.channel === channel).map((entry) => entry.request),
    emitFocus: focused => { focusListeners.forEach(listener => listener(focused)) },
    emitEngineProgress: (progress) => {
      for (const listener of [...progressListeners]) listener(progress)
    },
    emitServerStatus: (status) => {
      options.status = status
      for (const listener of [...serverListeners]) listener(status)
    },
    restore: () => {
      globalThis.fetch = previousFetch
      removeBridge()
      resetApiClient()
    },
  }
}

function remove<T>(list: T[], value: T): void {
  const at = list.indexOf(value)
  if (at >= 0) list.splice(at, 1)
}

function abortError(): Error {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError')
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
}
