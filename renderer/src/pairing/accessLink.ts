/** Mirror the separately shipped phone parser: action in the authority,
 * access_token as the key, and a normalized server address. Escape query values
 * against the unreserved set so plus signs cannot turn into spaces.
 * The token key also identifies credentials to the phone's log redactor. */

export const ACCESS_SCHEME = 'krobi'
export const ACCESS_ACTION = 'acceso'
export const SERVER_KEY = 'server'
/** Not `token`. See rule 2 in this file's header. */
export const TOKEN_KEY = 'access_token'

/**
 * Trim, assume `http://` for a bare host:port, drop trailing slashes.
 *
 * The `http` default is not laziness: nobody types a scheme for a LAN address,
 * and defaulting to `https` would point the phone at a port the home server has
 * no certificate for and fail at the TLS handshake rather than at anything
 * legible.
 */
export function normalizeServer(raw: string): string {
  let text = raw.trim()
  if (text === '') return text
  if (!text.includes('://')) text = `http://${text}`
  while (text.endsWith('/')) text = text.slice(0, -1)
  return text
}

/** Require a normalized fixed point so the encoded address and the phone's effective address agree. */
function isUsableServer(normalized: string): boolean {
  if (normalized === '') return false
  if (normalizeServer(normalized) !== normalized) return false
  try {
    const url = new URL(normalized)
    return url.protocol !== '' && url.hostname !== '' && !isLoopbackHost(url.hostname)
  } catch {
    return false
  }
}

/** Reject loopback because a scanning phone would connect to itself.
 * A locally hosted server needs its LAN address for pairing. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  )
}

/** Whether `server` is an address only this computer can reach; the pairing UI says so instead of drawing a code. */
export function isLoopbackServer(server: string): boolean {
  try {
    return isLoopbackHost(new URL(normalizeServer(server)).hostname)
  } catch {
    return false
  }
}

/** Escape against RFC 3986's unreserved set with uppercase hex to match the phone parser byte for byte. */
function escapeComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/** Return null for unusable addresses. The result contains a live credential:
 * keep it in the QR renderer, and use describeAccessLink for diagnostics. */
export function buildAccessLink(server: string, token: string): string | null {
  const address = normalizeServer(server)
  const secret = token.trim()
  if (secret === '' || !isUsableServer(address)) return null
  const query = `${SERVER_KEY}=${escapeComponent(address)}&${TOKEN_KEY}=${escapeComponent(secret)}`
  return `${ACCESS_SCHEME}://${ACCESS_ACTION}?${query}`
}

/** Describe the address and token length only so diagnostics can distinguish an absent token without exposing it. */
export function describeAccessLink(server: string, token: string): string {
  return `acceso para ${normalizeServer(server)} (token de ${token.trim().length} caracteres)`
}
