/** Preserve HTTP status so screens can distinguish access denial, missing data and retryable failures. */
import i18n from '../i18n'

/** What layer failed. Kept separate from `status` because three of these have none. */
export type ApiErrorKind =
  /** The request never got an answer: the server is down, the LAN is gone, the VPN dropped. */
  | 'network'
  /** The server answered, and the answer was a failure status. `status` is set. */
  | 'http'
  /** The server answered with a body this client cannot read. See the `malformed` note below. */
  | 'malformed'
  /** The preload bridge is missing, so the backend's address could never be resolved. */
  | 'bridge'

interface ApiErrorInit {
  kind: ApiErrorKind
  status?: number | null
  method: string
  path: string
  /** The parsed (or raw text) response body, exactly as it arrived. */
  body?: unknown
  message: string
  cause?: unknown
}

export class ApiError extends Error {
  readonly kind: ApiErrorKind
  /** The HTTP status, or null when the request never reached the point of having one. */
  readonly status: number | null
  readonly method: string
  readonly path: string
  readonly body: unknown
  constructor(init: ApiErrorInit) {
    super(init.message, { cause: init.cause })
    this.name = 'ApiError'
    this.kind = init.kind
    this.status = init.status ?? null
    this.method = init.method
    this.path = init.path
    this.body = init.body

    // Restore the prototype so instanceof survives bundlers that downlevel built-in subclasses.
    Object.setPrototypeOf(this, ApiError.prototype)
  }

  /** Build display text when read so cached errors follow language changes.
   * Keep diagnostic message text separate for logs. */
  get userMessage(): string {
    return userMessageFor(this.kind, this.status, this.body)
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError
}

/** 401: the credential was missing, wrong, or has been revoked. */
export function isUnauthorized(error: unknown): boolean {
  return isApiError(error) && error.status === 401
}

/** 403: authenticated, and still not allowed. Never fold this into 404. */
export function isForbidden(error: unknown): boolean {
  return isApiError(error) && error.status === 403
}

/** 404: there is no such thing. Never fold this into 403. */
export function isNotFound(error: unknown): boolean {
  return isApiError(error) && error.status === 404
}

/**
 * Any 4xx. The client asked for something the server understood and refused —
 * so the answer will not change on its own, which is what makes this the retry
 * predicate's pivot (see query-client.ts).
 */
export function isClientError(error: unknown): boolean {
  return isApiError(error) && error.status !== null && error.status >= 400 && error.status < 500
}

/**
 * The `detail` string FastAPI puts on its error bodies, when there is one.
 *
 * Read for logs and for developer-facing surfaces only. It is English, written
 * by the server, and is not a substitute for `userMessage`.
 */
export function serverDetail(error: unknown): string | null {
  if (!isApiError(error)) return null
  const body = error.body
  if (typeof body === 'string' && body.trim() !== '') return body
  if (body !== null && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail
    if (typeof detail === 'string') return detail
  }
  return null
}

function userMessageFor(kind: ApiErrorKind, status: number | null, body: unknown): string {
  if (kind === 'bridge') {
    return i18n.t("The app couldn't work out where your nest is.")
  }
  if (kind === 'network') {
    return i18n.t("Couldn't reach your nest.")
  }
  if (kind === 'malformed') {
    return i18n.t("Your nest answered something this app doesn't understand.")
  }
  switch (status) {
    case 401:
      // A rejected token requires sign-in on this device.
      return i18n.t("This device no longer has access to your nest. Sign in again.")
    case 403:
      // Keep access denial distinct from absence so the user does not search for a visible item.
      return i18n.t("This exists, but it isn't yours.")
    case 404:
      return i18n.t("This is no longer in your nest.")
    case 409:
      // The backend answers 409 to the synthetic principals (`shared-secret`,
      // `local`, `anonymous`) on every per-user route: there is no row to file
      // anything under. That is a configuration answer, not a transient one.
      return i18n.t("This credential has no account of its own in this nest.")
    case 422:
      return i18n.t("Your nest rejected the data sent.")
    default:
      break
  }
  if (status !== null && status >= 500) {
    return i18n.t("Your nest failed to answer. Try again.")
  }
  if (status !== null && status >= 400) {
    const detail = typeof body === 'object' && body !== null && 'detail' in body
      ? (body as { detail: unknown }).detail
      : null
    return typeof detail === 'string' && detail.trim() !== ''
      ? i18n.t("Your nest rejected the request: {{detail}}", { detail })
      : i18n.t("Your nest rejected the request.")
  }
  return i18n.t("Something went wrong talking to your nest.")
}
