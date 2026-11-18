/**
 * The setup link (contracts/setup-link.json): the one line a server install prints,
 * `krobi://<host>:<port>/setup#<code>`, pasted into the first run's "Setup link".
 *
 * The code is a claim secret. Nothing here logs it, and the copy kept across the
 * relaunch that `server:use` triggers lives only until the claim, or an hour.
 */
export type SetupLinkError = 'empty' | 'not-a-link' | 'not-setup' | 'bad-host' | 'no-code' | 'bad-code'
export type SetupLink =
  | { ok: true; address: string; code: string; redacted: string }
  | { ok: false; error: SetupLinkError }

const CODE = /^[A-Za-z0-9_-]{20,128}$/
const HOST = /^[a-z0-9.-]+$|^\[[0-9a-f:]+\]$/

export function parseSetupLink(input: string): SetupLink {
  const raw = input.trim()
  if (!raw) return { ok: false, error: 'empty' }
  const match = /^krobi:\/\/([^/#?]*)(\/[^#?]*)?(?:#(.*))?$/i.exec(raw)
  if (!match) return { ok: false, error: 'not-a-link' }
  const [, authority, path = '', fragment] = match
  if (authority.includes('@')) return { ok: false, error: 'bad-host' }
  const at = authority.lastIndexOf(':')
  const bracketed = authority.startsWith('[')
  const hasPort = at > -1 && (!bracketed || authority.lastIndexOf(']') < at)
  const host = (hasPort ? authority.slice(0, at) : authority).toLowerCase()
  const port = hasPort ? authority.slice(at + 1) : '8000'
  if (!host || !HOST.test(host) || !/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return { ok: false, error: 'bad-host' }
  if (path.replace(/\/+$/, '') !== '/setup') return { ok: false, error: 'not-setup' }
  if (fragment === undefined || fragment === '') return { ok: false, error: 'no-code' }
  if (!CODE.test(fragment)) return { ok: false, error: 'bad-code' }
  return { ok: true, address: `http://${host}:${port}`, code: fragment, redacted: `krobi://${host}:${port}/setup#…` }
}

const KEY = 'krobi.setup-link-code'
const TTL_MS = 60 * 60 * 1000

/** Keep the code for the account step, which runs after the app relaunches on the new nest. */
export function rememberSetupCode(address: string, code: string, now = Date.now()): void {
  try { localStorage.setItem(KEY, JSON.stringify({ host: hostOf(address), code, at: now })) } catch { /* no storage: the account step asks */ }
}

/** The remembered code if it was for this nest and is fresh; otherwise null. */
export function setupCodeFor(address: string | null | undefined, now = Date.now()): string | null {
  if (!address) return null
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { host?: string; code?: string; at?: number } | null
    if (!saved?.code || !saved.at || now - saved.at > TTL_MS) return null
    return saved.host === hostOf(address) ? saved.code : null
  } catch {
    return null
  }
}

export function forgetSetupCode(): void {
  try { localStorage.removeItem(KEY) } catch { /* nothing kept */ }
}

function hostOf(address: string): string {
  try { return new URL(address).host.toLowerCase() } catch { return address.toLowerCase() }
}
