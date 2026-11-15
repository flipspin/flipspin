import { bridge, hasBridge } from '../bridge'
import type { LogLevel } from './ipc'
import { notify } from '../ui/notifications'

export const LOG_SCOPES = ['app', 'playback', 'library', 'lyrics', 'stems', 'analysis', 'downloads', 'acquisition', 'sync', 'settings', 'auth', 'connection', 'plugins'] as const
export type LogScope = typeof LOG_SCOPES[number]
export type ScopedLogger = Record<LogLevel, (message: string, data?: unknown) => void>

/** One physical line, including stacks, cycles, BigInts and hostile objects. */
export function formatLogValue(value: unknown): string {
  try {
    const seen = new WeakSet<object>()
    const json = typeof value === 'string' ? value : JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'bigint') return String(item)
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]'
        seen.add(item)
        if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack, cause: item.cause }
      }
      return item
    })
    return Array.from(json ?? String(value), char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '\u2028' || char === '\u2029' ? ' ' : char).join('')
  } catch {
    return '[Unserializable]'
  }
}

function scoped(prefix: string): ScopedLogger {
  const write = (level: LogLevel, message: string, data?: unknown) => {
    try {
      const line = `${prefix} ${formatLogValue(message)}${data === undefined ? '' : ` ${formatLogValue(data)}`}`
      const fallback = () => { try { console[level](line) } catch { /* No remaining log sink. */ } }
      if (!hasBridge()) { fallback(); return }
      void Promise.resolve(bridge().invoke('log:write', { level, message: line })).catch(fallback)
    } catch { /* Logging must remain safe inside a catch. */ }
  }
  return {
    debug: (message, data) => write('debug', message, data),
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
  }
}

export const log = Object.fromEntries(LOG_SCOPES.map(scope => [scope, scoped(`[${scope}]`)])) as Record<LogScope, ScopedLogger>

/** Called by the host with its discovered directory id, never by a log message. */
export function pluginLogger(id: string): ScopedLogger {
  return scoped(`[plugin:${id.replace(/[^a-zA-Z0-9_-]/g, '_')}]`)
}

export function reportError(scope: LogScope, { userMessage, error }: { userMessage: string; error: unknown }): void {
  log[scope].error(userMessage, error)
  let detail = ''
  try {
    // Only the first message line: a string rejection can itself be a stack.
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
    detail = formatLogValue(message.split(/[\r\n\u2028\u2029]/, 1)[0]).slice(0, 100)
  } catch { /* A broken error object still gets the user-facing message. */ }
  // A detail that only repeats the message would show the same sentence twice.
  if (!detail || detail === userMessage) notify({ level: 'error', message: userMessage, logged: true })
  else notify({ level: 'error', title: userMessage, message: detail, logged: true })
}
