/** Forward logs to the shell because packaged builds hide the console.
 * Never throw or reject: logging must not replace the failure being handled. */

import { BRIDGE_KEY, type LogLevel, type KrobiBridge } from './ipc'

export type LogContext = Record<string, unknown>

const CONSOLE_METHOD: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
}

/** Read the bridge at call time so an early lookup cannot cache its absence for the window's lifetime. */
function readBridge(): KrobiBridge | null {
  try {
    const host = globalThis as Record<string, unknown>
    const candidate = host[BRIDGE_KEY]
    if (candidate && typeof (candidate as KrobiBridge).invoke === 'function') {
      return candidate as KrobiBridge
    }
  } catch {
    // A locked-down global that throws on property access is still a "no bridge"
    // answer, not a reason to bring the caller down.
  }
  return null
}

/** Errors do not survive structured cloning; this is the plain shape that does. */
export function describeError(error: unknown): LogContext {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? null }
  }
  return { name: 'NonError', message: String(error), stack: null }
}

/** Make context JSON-safe before IPC; replace cyclic values with a marker instead of throwing from logging. */
function toPlainContext(context: LogContext | undefined): LogContext | undefined {
  if (!context) return undefined
  try {
    const json = JSON.stringify(context, (_key, value: unknown) =>
      value instanceof Error ? describeError(value) : value,
    )
    if (json === undefined) return undefined
    return JSON.parse(json) as LogContext
  } catch {
    return { unserializableContext: String(context) }
  }
}

function writeToConsole(level: LogLevel, message: string, context?: LogContext): void {
  try {
    const method = CONSOLE_METHOD[level]
    if (context) {
      console[method](`[krobi] ${message}`, context)
    } else {
      console[method](`[krobi] ${message}`)
    }
  } catch {
    // No console either. There is nowhere left to report to, and refusing to
    // return would take the caller down with us.
  }
}

function write(level: LogLevel, message: string, context?: LogContext): void {
  const payload = toPlainContext(context)
  const bridge = readBridge()

  if (!bridge) {
    // Degraded mode: unit tests and a browser-only dev run have no preload.
    writeToConsole(level, message, payload)
    return
  }

  try {
    const sent = bridge.invoke('log:write', { level, message, ...(payload ? { context: payload } : {}) })
    // The bridge returns a promise. An unawaited rejection here becomes an
    // unhandled rejection the app never asked for, so it is caught and the line
    // falls back to the console rather than disappearing.
    void Promise.resolve(sent).catch(() => {
      writeToConsole(level, message, payload)
    })
  } catch {
    writeToConsole(level, message, payload)
  }
}

export const logger = {
  debug: (message: string, context?: LogContext): void => write('debug', message, context),
  info: (message: string, context?: LogContext): void => write('info', message, context),
  warn: (message: string, context?: LogContext): void => write('warn', message, context),
  error: (message: string, context?: LogContext): void => write('error', message, context),
  /** Escape hatch for code that already has the level as a value. */
  write,
}

/** True when logs are reaching main. Used by tests and the about panel. */
export function isLogBridgeAvailable(): boolean {
  return readBridge() !== null
}
