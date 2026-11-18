/** The renderer and native adapter share channel names and payload types here.
 * Payloads remain plain JSON-shaped data across the process boundary. */

/** An unchosen shell neither probes nor starts a server until the chooser calls
 * `server:use`; a null address selects this computer and an address selects another. */
export type ServerMode = 'external' | 'child' | 'unchosen'

/** Server problems cross the boundary as stable codes so the renderer can
 * translate the explanation. */
export type ServerProblem = 'occupied-by-other' | 'port-busy' | 'start-failed' | 'not-installed'

/** Connection state keeps reachability, authentication and nest identity distinct. */
export interface ServerConnection {
  state: 'connecting' | 'connected' | 'unreachable' | 'needs-auth' | 'wrong-nest' | 'unchosen'
  /** State-entry timestamps use Unix epoch milliseconds. */
  since: number
  attempt: number
  lastError: 'refused-route' | 'no-network' | 'refused-port' | 'connection-lost' | 'timeout' | 'not-krobi' | 'bad-body' | null
  checks: { id: 'this-computer' | 'route' | 'krobi'; status: 'ok' | 'warn' | 'bad' | 'idle'; detail: string | null }[]
}

export interface ServerStatus {
  /** The shell caches the last validated nest name before the first probe. */
  name: string | null
  connection: ServerConnection
  mode: ServerMode | null
  baseUrl: string | null
  port: number | null
  /** The PID belongs to the server process and is null when unreported. */
  pid: number | null
  /** The identity belongs to the library rather than the process; older servers report null. */
  instanceId: string | null
  /** Servers without identity support remain unidentified. */
  identified: boolean
  reachable: boolean
  /** An adopted server runs independently of the shell. */
  adopted: boolean
  /** Only servers started by this app belong to its shutdown lifecycle. */
  ownedByUs: boolean
  problem: ServerProblem | null
  /** Startup remains distinct from failure while the bundled server unpacks
   * and starts; the window can open before the server answers. */
  starting: boolean
  /** Pairing uses the LAN address because `baseUrl` is loopback in child mode.
   * The address is null outside child mode or when no LAN interface is up. */
  lanUrl: string | null
  /** Requests use an alternate nest address only when the configured address
   * is unavailable at startup; credential lookup stays keyed by `baseUrl`, and
   * the per-launch route is optional for compatibility with older shells. */
  via?: string | null
}

/** The shell reads only `lan`, `tailscale.url` and `externalUrl` from the network
 * response and accepts only HTTP(S) origins. */
export interface ServerNetwork {
  lan: string[]
  tailscale: { ip: string; name: string | null; url: string } | null
  externalUrl: string | null
}

/** LAN discovery returns only nests confirmed by their handshake. */
export interface DiscoveredNest {
  /** The confirmed HTTP address is suitable for `server:use` without another probe. */
  url: string
  /** The name comes from `/api/status`, with the mDNS name as fallback. */
  name: string
  /** Older servers without identity support report null. */
  instanceId: string | null
  version: string | null
}

/** Handshake metadata is available before authentication. */
export interface ServerHandshake {
  app: string
  version: string
  instanceId: string
  /** The public nest name is optional for compatibility with older servers. */
  name?: string
  /** An unclaimed server requires first-run account setup. */
  isInit: boolean
  authMethods: string[]
  /** The data location is exposed only before the first account claim. */
  dataDir?: string
  /** The setup-token requirement is exposed only before the first account claim. */
  setupTokenRequired?: boolean
  /** Setup completion is optional for compatibility with older servers. */
  setupDone?: boolean
}

/** Identity metadata excludes the credential secret. */
export interface AuthIdentity {
  userId: string | null
  label: string | null
  role: string | null
  /** Token presence is reported without exposing the token. */
  hasToken: boolean
}

/** Login-item state reflects OS settings, including approval denied outside the app. */
export interface LoginItemState {
  supported: boolean
  enabled: boolean
  status: 'enabled' | 'disabled' | 'requires-approval' | 'not-found' | 'unknown' | 'unsupported'
  error?: 'unsupported-platform' | 'registration-failed' | 'read-failed' | 'invalid-executable'
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Offline state values remain compatible with stored records and native replies. */
export type OfflineFileState = 'en fila' | 'descargando' | 'descargado' | 'fallido' | 'desactualizado' | 'ya no está en el nido' | 'no descargado'
export interface OfflineTrackStatus {
  key: string
  pool: 'offline' | 'cache' | null
  state: OfflineFileState
  bytes: number
  etag: string | null
  verifiedAt: number | null
  lastPlayedAt: number | null
  error: string | null
}
export interface OfflineStatus {
  pins: number
  files: number
  bytes: number
  tracks: OfflineTrackStatus[]
}
export interface OfflinePin {
  id: string
  kind: 'song' | 'album' | 'playlist' | 'library'
  ref: string
  tracks: string[]
}
export interface OfflinePools {
  /** Pin metadata is optional for compatibility with older shells. */
  pins?: OfflinePin[]
  offline: { bytes: number; files: number; location: string }
  cache: { bytes: number; files: number; location: string }
  cacheBudget: number
}

export type UploadFailure = 'not-audio' | 'changed' | 'unreadable' | 'damaged' | 'no-es-audio' | 'archivo-danado' | 'muy-grande' | 'sin-espacio' | 'fallo-subida'
export interface UploadItem {
  id: string
  sha256: string
  name: string
  bytes: number
  offset: number
  state: 'por-subir' | 'ya-estaba' | 'subiendo' | 'importando' | 'agregada' | 'no-apta' | 'fallida'
  reason: UploadFailure | null
  duplicate: boolean
  already?: boolean
}
export interface UploadBatch {
  folder: string | null
  keepAwake?: boolean
  awake?: boolean | 'unsupported'
  paused?: 'asleep' | 'no-network' | 'nest-unreachable' | 'signed-out' | 'no-space' | 'drive-missing' | null
  sendingPaused?: boolean
  id: string
  phase: 'revisando' | 'resumen' | 'subiendo' | 'terminado'
  files: UploadItem[]
  maxBytes?: number
  reviewed?: number
  total?: number
  current?: string
  error?: string
}
export type UploadChoice = 'use-nest' | 'keep-both'

export type SnapshotKind = 'listing' | 'library' | 'playlists' | 'home' | `playlist:${string}`
export interface LibrarySnapshot { kind: SnapshotKind; body: string; etag: string | null; fetchedAt: number }
export interface OutboxIntent {
  id: string; idempotencyKey: string; intent: string; body: string; createdAt: number
  attempts: number; lastError: string | null; state: 'queued' | 'failed'
}

export interface LocalLogPage {
  path: string
  lines: string[]
  truncated: boolean
  sizeBytes: number
  matched: number
  scanned: number
}

export interface IpcInvokeContract {
  /** Independent reasons keep playback and uploads from releasing each other. */
  'playback:activity': { request: { active: boolean; reason: string }; response: { ok: boolean } }
  'window:get-focus': { request: undefined; response: boolean }
  'files:save-key-export': {
    request: { name: string; contents: string }
    response: { ok: boolean; cancelled: boolean }
  }
  'upload:start': {
    request: { pick: 'folder' | 'files' } | { id: string; duplicates: UploadChoice }
    response: UploadBatch | null
  }
  'upload:keep-awake': { request: { enabled?: boolean }; response: { enabled: boolean } }
  'upload:pause': { request: { paused: boolean }; response: { paused: boolean } }
  'upload:status': { request: void; response: { batches: UploadBatch[] } }
  'upload:stop': { request: { id: string }; response: UploadBatch }
  'upload:retry-failed': { request: { id: string }; response: UploadBatch }
  'offline:snapshot': { request: { kind: SnapshotKind }; response: LibrarySnapshot | null }
  'offline:mode': { request: { forced?: boolean }; response: { forced: boolean } }
  'offline:outbox': {
    request: { action?: 'list' | 'retry' | 'discard' | 'enqueue'; id?: string; intent?: 'library-add' | 'library-remove' | 'playlist-edit'; body?: unknown }
    response: OutboxIntent[]
  }
  'offline:play': { request: { trackKey: string; listenedAt: number; clientPlayId: string }; response: { ok: true } }
  'offline:sync': { request: void; response: { ok: true } }

  /** Rust selects the account and nest scope; callers cannot override it. */
  'offline:pin': {
    request: {
      kind: 'song' | 'album' | 'playlist' | 'library'
      ref: string
      /** Append mode adds receipts without recreating a removed pin. */
      mode?: 'ensure' | 'append'
      /** The caller supplies expanded tracks until a durable offline snapshot is available.
       * Keys use decoded album/file paths. */
      tracks: { key: string; bytes?: number; inLibrary: boolean }[]
    }
    response: { ok: true; pinId: string } | { ok: false; reason: 'library-required-online' | 'library-add-failed' | 'track-missing' | 'no-space' }
  }
  'offline:unpin': {
    request: { pinId: string }
    response: { ok: true }
  }
  'offline:status': {
    request: { keys: string[] }
    response: OfflineStatus
  }
  'proxy:open': { request: void; response: { requestId: string } }
  'proxy:cancel': { request: { requestId: string }; response: { ok: boolean } }
  'offline:pools': {
    request: { action: 'get' | 'clear-cache' | 'remove-downloads' }
    response: OfflinePools
  }
  'system:login-item-get': {
    request: void
    response: LoginItemState
  }
  'system:login-item-set': {
    request: { enabled: boolean }
    response: LoginItemState
  }
  /** The renderer uses the origin selected by the shell for HTTP requests. */
  'app:get-backend-origin': {
    request: void
    response: {
      origin: string
      /** Persisted credential key; independent of transport and reachability. */
      backendKey: string
      /** Remembered, validated identity for migrating older local caches. */
      instanceId: string | null
    }
  }
  /** Version reporting identifies the native shell in diagnostics. */
  'app:get-version': {
    request: void
    response: { version: string }
  }
  /** Device labels use the macOS Computer Name, then the hostname, then "Flipspin". */
  'app:get-device-name': {
    request: void
    response: { name: string }
  }

  'server:stream-snapshot': { request: undefined; response: { hello: ServerHello | null; stream: ServerStream } }
  /** Retrying uses the current server selection. */
  'server:retry-now': { request: void; response: { ok: boolean } }
  /** Only a 401/403 from `/api/me` pauses probes until `auth:changed`. */
  'server:report-auth': { request: { status: 401 | 403 }; response: { ok: boolean } }
  'server:get-status': {
    request: void
    response: ServerStatus | null
  }
  /** The shell probes without changing server selection, handles redirects and
   * distinguishes transport failures from HTTP statuses outside renderer CORS rules. */
  'server:probe': {
    request: { address: string }
    response:
      | { ok: true; url: string; handshake: ServerHandshake }
      /** Failure reasons remain codes that the renderer translates. */
      | { ok: false; reason: 'unreachable' | 'not-our-server' | 'redirected' | 'insecure-downgrade' | 'invalid-address' }
  }
  /** Network updates follow an authenticated request so the shell can trust
   * the nest identity and alternate addresses for the next launch.
   * Local and environment-locked backends reject these updates. */
  'server:set-network': {
    request: ServerNetwork
    response: { ok: boolean; reason?: 'local-backend' | 'locked' }
  }
  /** LAN results are handshake-validated and deduplicated by `instanceId` during
   * a roughly two-second discovery window; unavailable multicast returns an empty list.
   * Manual addresses remain available because mDNS does not cross a VPN. */
  'server:discover': {
    request: void
    response: { nests: DiscoveredNest[] }
  }
  /** The local setup token lets "Create account" claim the LAN-listening child
   * server without manual code entry; it is null outside child mode or before the token file exists. */
  'server:local-setup-token': {
    request: void
    response: { token: string | null }
  }
  /** Server selection persists the first-run choice and relaunches the app
   * so process ownership, proxy origin, credentials and caches use the new server. */
  'server:use': {
    request: { address: string | null }
    response: { ok: boolean; relaunching?: boolean; reason?: string }
  }

  /** Credential descriptions expose metadata only; memory storage includes the persistence failure reason. */
  'credentials:describe': {
    request: void
    response: {
      store: 'macos-keychain' | 'windows-credential-manager' | 'secret-service' | 'file' | 'memory'
      reason: string | null
      nest: { name: string | null; address: string }
      deviceName: string | null
      linkedAt: string | null
      lastUsed: string | null
      state: 'activa' | 'rechazada' | 'sin-conexion'
    }
  }
  /** File persistence requires explicit, remembered consent for private app-data storage. */
  'credentials:save-to-file': {
    request: void
    response: { ok: boolean; store: 'file' }
  }

  /** Proxy secrets stay scoped to an origin; replies expose only names and presence. */
  'headers:get': { request: { origin: string } | void; response: { name: string; set: boolean }[] }
  'headers:set': { request: { origin?: string; headers: { name: string; value?: string }[] }; response: { name: string; set: boolean }[] }
  /** Credentials are read on demand, never broadcast in events. */
  'auth:get': {
    request: void
    response: AuthIdentity & { token: string }
  }
  /** Credential adoption delegates persistence to the shell. */
  'auth:set': {
    request: { token: string; userId?: string | null; label?: string | null; role?: string | null }
    response: { ok: boolean; persisted?: boolean; reason?: string }
  }
  /** Sign-out restores the credential held before account sign-in. */
  'auth:clear': {
    request: void
    response: { ok: boolean }
  }

  /** Renderer logs share the native log stream so packaged diagnostics include
   * errors that otherwise remain in a closed developer console. */
  'log:sources': {
    request: void
    response: { helper: boolean }
  }
  'log:read': {
    request: { source: 'desktop' | 'helper'; lines: number; q: string }
    response: LocalLogPage
  }
  'log:open-folder': {
    request: { source: 'desktop' | 'helper' }
    response: { ok: boolean }
  }
  'log:clear': {
    request: { source: 'desktop' | 'helper' }
    response: { source: 'desktop' | 'helper'; clearedBytes: number }
  }
  'log:write': {
    request: { level: LogLevel; message: string; context?: Record<string, unknown> }
    response: void
  }

  /** The shell provisions the local lyrics helper and supervises its agent
   * while the configured backend owns the job queue. */
  'lyrics:engine-status': {
    request: void
    response: MacEngineStatus
  }
  /** Installation runs in the background and reports through `lyrics:engine-progress`. */
  'lyrics:engine-install': {
    request: { target: 'engine' | 'lyrics' | 'stems' | 'analysis' | 'gpu' } | void
    response: { started: boolean; already?: boolean; reason?: string }
  }
  'lyrics:engine-remove': {
    request: { target: 'engine' | 'lyrics' | 'stems' | 'analysis' | 'gpu' }
    response: { ok: boolean }
  }
  /** Model repair uses the installed helper and the shared install-progress channel. */
  'lyrics:engine-repair': {
    request: void
    response: { started: boolean; already?: boolean; running?: IpcEventContract['lyrics:engine-progress']; reason?: 'unsupported-platform' | 'not-installed' }
  }
  /** The helper agent uses the configured backend and the credential held by the shell. */
  'lyrics:agent-start': {
    request: void
    response: { ok: boolean; already?: boolean; reason?: 'not-installed' | 'no-token' | 'local-backend' | 'spawn-failed'; detail?: string }
  }
  'lyrics:worker-set': {
    request: { enabled: boolean }
    response: { ok: boolean; reason?: 'not-owner' | 'account-required' | 'token-rejected' | 'unsupported-platform' | 'local-backend' | 'not-installed' | 'no-token' | 'spawn-failed' }
  }
  'lyrics:worker-resume': {
    request: void
    response: { ok: boolean; reason?: string }
  }
  'lyrics:worker-configure': {
    request: { tray?: boolean; language?: 'es' | 'en' }
    response: { ok: boolean }
  }
  'lyrics:agent-stop': {
    request: void
    response: { stopped: boolean }
  }
}

export interface AddonStatus {
  installed: boolean
  ready: boolean
  sizeBytes: number | null
  /** The shared Demucs model is excluded from `sizeBytes`. */
  sharedBytes?: number | null
  /** Analysis packages are excluded from the engine's `sizeBytes`. */
  runtimeBytes?: number
  installing?: boolean
  error?: string | null
  included?: boolean
  available?: boolean
  card?: string | null
  driver?: string | null
  reason?: string | null
  downloadBytes?: number
}

export interface MacEngineStatus {
  engineReady?: boolean
  addons?: Record<'lyrics' | 'stems', AddonStatus> & Partial<Record<'analysis' | 'gpu', AddonStatus>>
  hint?: 'ready' | 'models-missing' | 'installing' | 'not-installed' | 'broken'
  enabled: boolean
  eligible: boolean
  tray: boolean
  workerId: string | null
  hardware: {
    name: string
    chip: string | null
    memoryBytes: number | null
    gpu: string | null
    accel: 'mlx' | 'cuda' | 'cpu'
    jobs: ('align' | 'transcribe' | 'stems' | 'analysis')[]
  }
  version: string | null
  sizeBytes: number | null
  local: { id: string; connected: boolean; state: string; lastError: string | null } | null
  /** The shell forwards the nest's public worker snapshot, including capabilities. */
  worker: (Partial<import('../api/generated/schema').SchemaMacWorker> & { id: string; state: string }) | null
  workerError: string | null
  supported: boolean
  installed: boolean
  agentRunning: boolean
  installing: { phase: string | null; percent: number | null; repairing?: boolean; target?: string } | null
  installError: string | null
  uv: boolean
  workerSource: string | null
  toolsDir: string
  modelsDir: string
}

/** Push channels have payloads without replies; listeners return an unsubscribe
 * function to bound their lifetime. */
export interface IpcEventContract {
  /** Main-window focus only; a focused detached player leaves data quiet. */
  'window:focus': boolean
  /** Upload events refresh the view; server status remains the source of reachability. */
  'upload:changed': UploadBatch
  'upload:error': string
  'offline:changed': { pins?: boolean; cache?: boolean; state?: boolean } | null
  'offline:synced': null
  /** Backend events report reachability independently of server selection. */
  'backend:status-changed': { reachable: boolean }
  /** Server events carry the current selection and connection health. */
  'server:changed': ServerChange
  'server:hello': ServerHello
  'server:stream': ServerStream
  'server:status-changed': ServerStatus
  'headers:changed': void
  /** Every window receives credential changes so requests use the current token. */
  'auth:changed': AuthIdentity
  /** Helper changes invalidate status; install progress reports phase, percent and completion. */
  'lyrics:worker-changed': null
  'lyrics:engine-progress': { running: boolean; phase: string | null; percent: number | null; error: string | null }
  /** Menu playback commands use the same transport actions as the renderer. */
  'player:command': 'toggle' | 'next' | 'previous'
  'view:command': 'toggle-sidebar' | 'toggle-side-column'
}

export type IpcInvokeChannel = keyof IpcInvokeContract
export type IpcEventChannel = keyof IpcEventContract

export type IpcRequest<C extends IpcInvokeChannel> = IpcInvokeContract[C]['request']
export type IpcResponse<C extends IpcInvokeChannel> = IpcInvokeContract[C]['response']
export type IpcEventPayload<C extends IpcEventChannel> = IpcEventContract[C]

/** Renderer consumers depend on the bridge type so native implementation
 * dependencies stay outside the renderer bundle. */
export interface KrobiBridge {
  /** Optional native HTTP transport; generated clients preserve request signals. */
  fetch?: (request: Request) => Promise<Response>
  invoke<C extends IpcInvokeChannel>(channel: C, request: IpcRequest<C>): Promise<IpcResponse<C>>
  /** Subscribers release listeners on unmount so closures cannot retain stale state
   * or accumulate across Strict Mode mounts. */
  on<C extends IpcEventChannel>(channel: C, listener: (payload: IpcEventPayload<C>) => void): () => void
}

/** The shared bridge key keeps native exposure and renderer lookup aligned. */
export const BRIDGE_KEY = 'krobi' as const

/** Opaque revisions can be counters or composite fingerprints. */
export type ChangeRevision = number | string
export interface ServerChange { area: string; rev: ChangeRevision; ids?: string[] | null }
export interface ServerHello { bootId: string; revisions: Record<string, ChangeRevision> }
export interface ServerStream { state: 'connected' | 'connecting' | 'lost' | 'auth'; since: number }
