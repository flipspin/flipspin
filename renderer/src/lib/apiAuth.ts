/** All desktop fetch bodies go through Rust; progress streams poll snapshots.
 * Browser development attaches the bearer token and retains native EventSource.
 * Saved proxy headers are injected only by Rust and never reach this module.
 */
import { API_BASE_URL, withApiToken } from "./api";
import { PollingEventSource } from "./progressSource";
import { getApiToken } from "./authToken";

export function isBackendUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const target = new URL(url);
    const backend = new URL(API_BASE_URL);
    const basePath = backend.pathname.replace(/\/+$/, "");
    return !target.username && !target.password && target.origin === backend.origin &&
      (!basePath || target.pathname === basePath || target.pathname.startsWith(`${basePath}/`));
  } catch {
    return false;
  }
}

function abortError() {
  return new DOMException("The operation was aborted.", "AbortError");
}

export async function proxyFetch(input: RequestInfo, init?: RequestInit, _originalFetch?: typeof fetch): Promise<Response> {
  const request = typeof input === "string" ? null : input;
  const method = String(init?.method || request?.method || "GET").toUpperCase();
  const candidateBody = init?.body;
  const headers = new Headers(request?.headers || undefined);
  new Headers(init?.headers || undefined).forEach((value, key) => headers.set(key, value));
  let body: string | null = null;
  let bodyBytes: number[] | null = null;
  if (candidateBody != null || (request && method !== "GET" && method !== "HEAD")) {
    // Request supplies the multipart boundary and encodes files without a text pass.
    const encoded = candidateBody != null
      ? new Request(typeof input === "string" ? input : input.url, { method, headers, body: candidateBody })
      : request!.clone();
    const contentType = encoded.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    if (typeof candidateBody === "string") body = candidateBody;
    else bodyBytes = Array.from(new Uint8Array(await encoded.arrayBuffer()));
  }

  if (init?.signal?.aborted || request?.signal?.aborted) throw abortError();
  const result = await window.desktopAPI!.requestBackend({
    url: typeof input === "string" ? input : input.url,
    method,
    headers: Object.fromEntries(headers.entries()),
    body,
    bodyBytes,
  });
  if (init?.signal?.aborted || request?.signal?.aborted) throw abortError();
  if (!result || result.status === 0) {
    throw new TypeError(result?.body || result?.statusText || "Backend request failed");
  }
  // Preserve raw bytes for binary bodies. Null-body statuses must not construct a Response with bytes.
  const nullBody = [101, 204, 205, 304].includes(result.status);
  const replyBody = nullBody ? null : result.bytes instanceof ArrayBuffer ? result.bytes : result.body || null;
  return new Response(replyBody, {
    status: result.status,
    statusText: result.statusText || "",
    headers: result.headers || {},
  });
}

function installFetchInterceptor() {
  const originalFetch = window.fetch.bind(window);

  window.fetch = function krobiAuthenticatedFetch(input, init) {
    // Attach credentials only to the configured backend; leave uninspectable requests unchanged.
    // URL objects have no .url field and fall through to the original fetch.
    const request = typeof input === "string" ? null : input as Request;
    const url = typeof input === "string" ? input : request?.url;
    if (!isBackendUrl(url)) return originalFetch(input, init);

    // Tauri's Rust client is not subject to webview CORS and attaches the
    // current credential itself. This keeps JSON/bootstrap calls compatible
    // with an older server, including multipart requests.
    if (window.desktopAPI?.requestBackend) {
      return proxyFetch(typeof input === "string" ? input : request!, init, originalFetch);
    }

    const token = getApiToken();
    if (!token) return originalFetch(input, init);

    const headers = new Headers((init && init.headers) || request?.headers);
    // Preserve explicit caller authorization.
    if (!headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    return originalFetch(input, { ...(init || {}), headers });
  };
}

function installEventSourceInterceptor() {
  const OriginalEventSource = window.EventSource;
  if (typeof OriginalEventSource !== "function") return;

  function KrobiEventSource(url: string | URL, config?: EventSourceInit) {
    if (isBackendUrl(url) && window.desktopAPI?.requestBackend && new URL(url).pathname.includes("/api/download-progress-stream/")) {
      return new PollingEventSource(url);
    }
    return new OriginalEventSource(isBackendUrl(url) ? withApiToken(url) : url, config);
  }
  KrobiEventSource.prototype = OriginalEventSource.prototype;
  // Callers read EventSource.CLOSED / .OPEN / .CONNECTING off the constructor.
  KrobiEventSource.CONNECTING = OriginalEventSource.CONNECTING;
  KrobiEventSource.OPEN = OriginalEventSource.OPEN;
  KrobiEventSource.CLOSED = OriginalEventSource.CLOSED;

  // This ordinary function is also constructable at runtime; retain its call signature.
  window.EventSource = KrobiEventSource as typeof KrobiEventSource & typeof EventSource;
}

if (typeof window !== "undefined") {
  installFetchInterceptor();
  installEventSourceInterceptor();
}
