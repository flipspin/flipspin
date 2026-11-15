/**
 * Remote access rules every client applies the same way (`contracts/remote-access.json`).
 *
 * The server is authoritative for `externalUrl`; `PUT /api/server/external-url`
 * answers 422 with the same reason codes; so this copy exists only to say what
 * is wrong before a request is sent. It mirrors
 * `backend/app/core/remote_access.py::normalise_external_url` case for case,
 * including the port kept exactly as typed (`URL` would drop `:443`), which is
 * why the address is split by hand rather than handed to `new URL`.
 */

export type ExternalUrlError = 'needs-https' | 'has-path' | 'has-credentials' | 'not-a-url'

export type ExternalUrlResult = { url: string | null } | { error: ExternalUrlError }

/** Probe outcome for the expected server identity. */
export type ProbeVerdict = 'same-nest' | 'other-nest' | 'not-krobi' | 'unreachable'

// One DNS label: letters, digits and inner hyphens, 1–63 characters.
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/
const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/

function validHost(host: string): boolean {
  if (!host || host.length > 253) return false
  if (host.startsWith('[') && host.endsWith(']')) return host.length > 2
  if (IPV4.test(host)) return host.split('.').every((part) => Number(part) <= 255)
  let ascii: string
  try {
    // The URL parser's IDNA step, the same one `str.encode("idna")` performs.
    ascii = new URL(`https://${host}`).hostname
  } catch {
    return false
  }
  return ascii
    .replace(/\.$/, '')
    .split('.')
    .every((label) => LABEL.test(label))
}

/** A typed domain as the canonical `https://host[:port]`, `null` to clear it. */
export function normalizeExternalUrl(raw: string): ExternalUrlResult {
  let text = raw.trim()
  if (!text) return { url: null }
  if (/\s/.test(text)) return { error: 'not-a-url' }
  if (!text.includes('://')) text = `https://${text}`

  const scheme = text.slice(0, text.indexOf('://')).toLowerCase()
  if (scheme !== 'https') return { error: 'needs-https' }

  const rest = text.slice(text.indexOf('://') + 3)
  const cut = rest.search(/[/?#]/)
  const authority = cut === -1 ? rest : rest.slice(0, cut)
  const tail = cut === -1 ? '' : rest.slice(cut)
  if (authority.includes('@')) return { error: 'has-credentials' }
  if (tail !== '' && tail !== '/') return { error: 'has-path' }

  const portMatch = /^(.*?)(?::(\d*))?$/.exec(authority)
  const host = (portMatch?.[1] ?? '').toLowerCase()
  const port = portMatch?.[2]
  if (!validHost(host)) return { error: 'not-a-url' }
  if (port !== undefined) {
    if (port === '' || Number(port) > 65535) return { error: 'not-a-url' }
    return { url: `https://${host}:${Number(port)}` }
  }
  return { url: `https://${host}` }
}

/** A `/api/status` body (null = no answer) against the nest's `instanceId`. */
export function probeVerdict(instanceId: string, answer: Record<string, unknown> | null): ProbeVerdict {
  if (answer === null) return 'unreachable'
  if (answer.app !== 'krobi') return 'not-krobi'
  return answer.instanceId === instanceId ? 'same-nest' : 'other-nest'
}

export type Route = 'tailscale' | 'wireguard' | 'domain' | 'local'
export type Reach = 'ok' | 'bad' | 'local' | 'none'
export type LinkState = 'ok' | 'bad' | 'none' | 'off'
export interface ReachInput {
  route: Route | null
  outside: { via: 'vpn' | 'tailscale' | 'proxy'; ago: number } | null
  tailscale: boolean
  domain: boolean
  verdicts: { tailscale: ProbeVerdict | null; domain: ProbeVerdict | null }
}
export interface ReachResult {
  route?: Route
  reach: Reach
  detail: string | null
  links: [{ state: LinkState; word: string }, { state: LinkState; word: string }]
}

/** Week units are opt-in for machine uptimes; remote-access contract output stays stable. */
export function ago(seconds: number, options: { weeks?: boolean } = {}): string {
  if (seconds < 60) return 'ahora'
  if (seconds < 3600) return `hace ${Math.floor(seconds / 60)} min`
  if (seconds < 86400) return `hace ${Math.floor(seconds / 3600)} h`
  if (options.weeks && seconds >= 7 * 86400) {
    const weeks = Math.floor(seconds / (7 * 86400))
    return `hace ${weeks} ${weeks === 1 ? 'semana' : 'semanas'}`
  }
  return `hace ${Math.floor(seconds / 86400)} d`
}

export function inferredRoute(input: Pick<ReachInput, 'route' | 'tailscale' | 'domain'>): Route {
  return input.route ?? (input.tailscale ? 'tailscale' : input.domain ? 'domain' : 'local')
}

/** Chosen route, proof and explicit probe, in contract order. No clock or I/O. */
export function reach(input: ReachInput): ReachResult {
  const route = inferredRoute(input)
  function result(status: Reach, detail: string | null, a: LinkState, word: string, b = a, second = word): ReachResult {
    return { ...(input.route === null ? { route } : {}), reach: status, detail, links: [{ state: a, word }, { state: b, word: second }] }
  }
  if (route === 'local') return result('local', null, 'off', 'sin acceso', 'off', '')
  if (route === 'wireguard') {
    const proven = input.outside?.via === 'vpn'
    const detail = proven ? ago(input.outside!.ago) : 'sin uso aún'
    return result(proven ? 'ok' : 'none', detail, proven ? 'ok' : 'none', detail, 'ok', 'red local')
  }
  if (route === 'tailscale' && !input.tailscale) return result('bad', 'no detectado', 'off', 'sin acceso', 'off', '')
  if (route === 'domain' && !input.domain) return result('none', 'sin dominio', 'none', 'sin dominio', 'none', 'sin comprobar')
  const verdict = input.verdicts[route]
  if (verdict === 'same-nest') return result('ok', 'conectado', 'ok', 'conectado')
  if (verdict !== null) {
    const word = { unreachable: 'sin respuesta', 'other-nest': 'responde otro nido', 'not-krobi': 'no es un nido de Krobi' }[verdict]
    return result('bad', word, 'bad', word, 'none', 'sin comprobar')
  }
  if (input.outside?.via === (route === 'tailscale' ? 'tailscale' : 'proxy')) {
    const word = ago(input.outside.ago)
    return result('ok', word, 'ok', word, 'ok', 'conectado')
  }
  return result('none', 'sin comprobar', 'none', 'sin comprobar')
}
