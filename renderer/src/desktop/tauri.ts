import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

import type {
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
  KrobiBridge,
} from '../lib/ipc'

interface Bootstrap {
  backendUrl: string
  backendIsRemote: boolean
  backendToken: string
  mediaProxyUrl: string
}

type Listener<T = unknown> = (payload: T) => void

function onEvent<T>(event: string, listener: Listener<T>): () => void {
  let disposed = false
  let unlisten: UnlistenFn | undefined
  void listen<T>(event, ({ payload }) => listener(payload)).then((stop) => {
    if (disposed) stop()
    else unlisten = stop
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

/** Subscribe before reading initial state so a blur during startup cannot be lost. */
let initialMainFocus = false
function onMainFocus(listener: Listener<boolean>): () => void {
  listener(initialMainFocus)
  let disposed = false
  let revision = 0
  let unlisten: UnlistenFn | undefined
  void listen<boolean>('window:focus', ({ payload }) => {
    if (disposed) return
    revision++
    initialMainFocus = payload
    if (!disposed) listener(payload)
  }).then(async stop => {
    if (disposed) { stop(); return }
    unlisten = stop
    const before = revision
    const focused = await bridgeInvoke('window:get-focus', undefined)
    if (!disposed && before === revision) { initialMainFocus = focused; listener(focused) }
  }).catch(() => { if (!disposed) listener(false) })
  return () => { disposed = true; unlisten?.() }
}

async function bridgeInvoke<C extends IpcInvokeChannel>(
  channel: C,
  request: IpcRequest<C>,
): Promise<IpcResponse<C>> {
  if (channel === 'server:stream-snapshot') await Promise.all([...serverListenersReady])
  return tauriInvoke<IpcResponse<C>>('bridge_invoke', { channel, request: request ?? null })
}

/** Read the length-prefixed JSON header and raw body separately so binary responses
 * survive the bridge without JSON encoding their bytes. */
export interface BackendReply {
  ok: boolean
  status: number
  statusText: string
  headers: Record<string, string>
  /** The body as text; what the legacy `backendRequest()` helper reads. */
  body: string
  /** The body verbatim; what `proxyFetch` hands to `Response`. */
  bytes: ArrayBuffer
}

function decodeBackendReply(raw: unknown): BackendReply {
  if (!(raw instanceof ArrayBuffer)) {
    // An older shell, or a mocked one: the JSON envelope of before.
    const legacy = (raw ?? {}) as Partial<BackendReply>
    const body = typeof legacy.body === 'string' ? legacy.body : ''
    return {
      ok: Boolean(legacy.ok),
      status: Number(legacy.status ?? 0),
      statusText: legacy.statusText ?? '',
      headers: legacy.headers ?? {},
      body,
      bytes: new TextEncoder().encode(body).buffer,
    }
  }
  const view = new DataView(raw)
  const headerLength = view.getUint32(0)
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(raw, 4, headerLength))) as Omit<
    BackendReply,
    'body' | 'bytes'
  >
  const bytes = raw.slice(4 + headerLength)
  let decodedBody: string | undefined
  return {
    ...header,
    bytes,
    // JSON callers read this and pay for one decode. proxyFetch consumes the
    // bytes directly, so audio/WAV/image responses never take a UTF-8 pass.
    get body() {
      if (decodedBody === undefined) decodedBody = new TextDecoder().decode(bytes)
      return decodedBody
    },
  }
}

const activeRequests = new Set<() => void>()

export async function requestBackend(request: unknown, signal?: AbortSignal): Promise<BackendReply> {
  signal?.throwIfAborted()
  const { requestId } = await bridgeInvoke('proxy:open', undefined)
  let cancelled = false
  const cancel = () => {
    cancelled = true
    void bridgeInvoke('proxy:cancel', { requestId }).catch(() => {})
  }
  activeRequests.add(cancel)
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  try {
    // Await Rust settlement even after abort: a worker cannot outrun cancellation.
    const reply = await tauriInvoke<unknown>('backend_request', { request: { ...(request as object), requestId } })
    if (cancelled) throw new DOMException('The operation was aborted.', 'AbortError')
    return decodeBackendReply(reply)
  } catch (error) {
    if (cancelled) throw new DOMException('The operation was aborted.', 'AbortError')
    throw error
  } finally {
    signal?.removeEventListener('abort', cancel)
    activeRequests.delete(cancel)
  }
}

/** The generated client hands us an encoded Request, including its signal. */
export async function fetchBackend(request: Request): Promise<Response> {
  const result = await requestBackend({
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    bodyBytes: request.body ? Array.from(new Uint8Array(await request.arrayBuffer())) : undefined,
  }, request.signal)
  if (!result.status) throw new TypeError(result.body || result.statusText || 'Backend request failed')
  return new Response([101, 204, 205, 304].includes(result.status) ? null : result.bytes, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  })
}

function contractBridge(): KrobiBridge {
  return {
    invoke: bridgeInvoke,
    fetch: fetchBackend,
    on<C extends IpcEventChannel>(channel: C, listener: Listener<IpcEventPayload<C>>): () => void {
      if (channel === 'server:changed' || channel === 'server:hello' || channel === 'server:stream') return onServerEvent(channel, listener)
      if (channel === 'window:focus') return onMainFocus(listener as Listener<boolean>)
      return onEvent(channel, listener)
    },
  }
}

/**
 * Install the native boundary before importing any module that can issue an
 * HTTP request. The compatibility object keeps the existing renderer stable
 * while its call sites move to the typed `window.krobi` contract.
 */
export async function installTauriBridge(): Promise<void> {
  if (!("__TAURI_INTERNALS__" in globalThis)) return

  window.addEventListener('pagehide', () => { for (const cancel of activeRequests) cancel() })
  const bootstrap = await tauriInvoke<Bootstrap>('desktop_bootstrap')
  initialMainFocus = await bridgeInvoke('window:get-focus', undefined)
  const krobi = contractBridge()
  const desktopAPI = {
    ping: () => 'pong',
    backendUrl: bootstrap.backendUrl,
    backendIsRemote: bootstrap.backendIsRemote,
    backendToken: bootstrap.backendToken,
    mediaProxyUrl: bootstrap.mediaProxyUrl,
    requestBackend,
    getAuthToken: () => bridgeInvoke('auth:get', undefined),
    setAuthToken: (request: IpcRequest<'auth:set'>) => bridgeInvoke('auth:set', request),
    clearAuthToken: () => bridgeInvoke('auth:clear', undefined),
    clearLog: (request: IpcRequest<'log:clear'>) => bridgeInvoke('log:clear', request),
    getServerUrl: () => tauriInvoke('bridge_invoke', { channel: 'server-get', request: null }),
    setServerUrl: (address: string | null) => bridgeInvoke('server:use', { address }),
    onAuthChanged: (listener: Listener<{ changed: true }>) => onEvent('auth-changed', listener),
    openFile: (path: string) => tauriInvoke('open_path', { path }),
    openExternal: (url: string) => tauriInvoke('open_external', { url }),
    downloadToDevice: (mediaPath: string, suggestedName: string) =>
      tauriInvoke('download_to_device', { request: { mediaPath, suggestedName } }),
    listDeviceDownloads: () => tauriInvoke('list_device_downloads'),
    selectBaseDir: () => tauriInvoke<string | null>('select_base_dir'),
    getTheme: () => tauriInvoke<string | null>('get_theme'),
    setTheme: (theme: string) => tauriInvoke('set_theme', { theme }),
    openPlayerWindow: () => tauriInvoke('open_player_window'),
    sendPlayerState: (payload: unknown) => void tauriInvoke('send_player_state', { payload }),
    onPlayerAction: (listener: Listener) => onEvent('player-action-to-main', listener),
    onPlayerPlayToggle: (listener: Listener) => onEvent('player-play-toggle', listener),
    onPlayerState: (listener: Listener) => onEvent('player-state', listener),
    sendPlayerAction: (payload: unknown) => void tauriInvoke('send_player_action', { payload }),
    sendPlayerPlayToggle: () => void tauriInvoke('send_player_play_toggle'),
    closePlayerWindow: () => void tauriInvoke('close_player_window'),
    requestMainShowQueue: () => void tauriInvoke('request_main_show_queue'),
  }

  Object.defineProperty(window, 'krobi', { configurable: false, value: krobi })
  Object.defineProperty(window, 'desktopAPI', { configurable: false, value: desktopAPI })
  onEvent('show-queue', () => window.dispatchEvent(new Event('krobi-show-queue')))
}

declare global {
  interface Window {
    krobi?: KrobiBridge
    desktopAPI?: DesktopApi
  }
}

interface DesktopApi {
  ping(): string
  backendUrl: string
  backendIsRemote: boolean
  backendToken: string
  mediaProxyUrl: string
  requestBackend(request: unknown, signal?: AbortSignal): Promise<BackendReply>
  getAuthToken(): Promise<IpcResponse<'auth:get'>>
  setAuthToken(request: IpcRequest<'auth:set'>): Promise<unknown>
  clearAuthToken(): Promise<unknown>
  getServerUrl(): Promise<unknown>
  setServerUrl(address: string | null): Promise<unknown>
  onAuthChanged(listener: Listener<{ changed: true }>): () => void
  openFile(path: string): Promise<unknown>
  openExternal(url: string): Promise<unknown>
  downloadToDevice(mediaPath: string, suggestedName: string): Promise<{
    ok: boolean
    cancelled: boolean
    path?: string
  }>
  listDeviceDownloads(): Promise<{
    downloads: Array<{ mediaPath: string; path: string }>
  }>
  selectBaseDir(): Promise<string | null>
  getTheme(): Promise<string | null>
  setTheme(theme: string): Promise<unknown>
  openPlayerWindow(): Promise<unknown>
  sendPlayerState(payload: unknown): void
  onPlayerAction(listener: Listener): () => void
  onPlayerPlayToggle(listener: Listener): () => void
  onPlayerState(listener: Listener): () => void
  sendPlayerAction(payload: unknown): void
  sendPlayerPlayToggle(): void
  closePlayerWindow(): void
  requestMainShowQueue(): void
}

// A synchronous disposer does not mean native listen() has finished. The stream
// snapshot waits for these registrations to close the subscribe/snapshot gap.
const serverListenersReady = new Set<Promise<UnlistenFn>>()
function onServerEvent<T>(channel: string, listener: Listener<T>): () => void {
  let disposed = false
  let unlisten: UnlistenFn | undefined
  const ready = listen<T>(channel, ({ payload }) => { if (!disposed) listener(payload) })
  serverListenersReady.add(ready)
  void ready.then(stop => {
    serverListenersReady.delete(ready)
    if (disposed) stop()
    else unlisten = stop
  }, () => { serverListenersReady.delete(ready) })
  return () => { disposed = true; unlisten?.() }
}
