/**
 * The application's log lines as entries a person reads: a sentence, then when ·
 * where · how bad, the raw text kept for opening. Two shapes arrive
 * (`app/infra/logging.py`): `krobi_errors.log` is one JSON object per line,
 * `krobi.log` is `YYYY-MM-DD HH:MM:SS±HH:MM LEVEL module: message`.
 * Legacy stamps without an offset are UTC. A line that is neither (a traceback)
 * belongs to the entry above it.
 *
 * Repeats are folded: the same level and message become one entry with ×N and
 * the newest time.
 */
import { msg } from '../i18n'
import type { Tone } from './parts'

export interface LogEntry {
  message: string
  level: string
  module: string
  /** null when the line carried no stamp this reader understands. */
  at: Date | null
  raw: string
  count: number
}

const CONSOLE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)?)\s+([A-Z]+)\s+([\w.]+)(?: \[[^\]]*\])?: (.*)$/

function parseTimestamp(stamp: string): Date | null {
  if (!stamp) return null
  const at = new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(stamp) ? stamp : `${stamp}Z`)
  return Number.isNaN(at.getTime()) ? null : at
}

function parseOne(line: string): Omit<LogEntry, 'count'> | null {
  const trimmed = line.trim()
  if (trimmed.startsWith('{')) {
    try {
      const record = JSON.parse(trimmed) as Record<string, unknown>
      const stamp = typeof record.timestamp === 'string' ? record.timestamp : ''
      const at = parseTimestamp(stamp)
      return {
        message: typeof record.message === 'string' ? record.message : trimmed,
        level: typeof record.level === 'string' ? record.level : '',
        module: typeof record.module === 'string' ? record.module : '',
        at,
        raw: line,
      }
    } catch {
      return null
    }
  }
  const native = /^\[(\d{4}-\d\d-\d\d)\]\[([^\]]+)\]\[([^\]]+)\]\[([A-Z]+)\]\s*(.*)$/.exec(trimmed)
  if (native) {
    const at = parseTimestamp(`${native[1]}T${native[2]}`)
    return { message: native[5], level: native[4], module: native[3], at, raw: line }
  }
  const match = CONSOLE.exec(trimmed)
  if (!match) return null
  const at = parseTimestamp(match[1].replace(' ', 'T'))
  return { message: match[4], level: match[2], module: match[3], at, raw: line }
}

/** Lines in file order → entries, newest first, repeats folded. */
export function parseLog(lines: readonly string[]): LogEntry[] {
  const entries: Omit<LogEntry, 'count'>[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    const parsed = parseOne(line)
    if (parsed) entries.push(parsed)
    else if (entries.length > 0 && (/^\s/.test(line) || line.startsWith('Traceback ') || /^\w*(?:Error|Exception):/.test(line))) entries[entries.length - 1].raw += `\n${line}`
    else entries.push({ message: line.trim(), level: '', module: '', at: null, raw: line })
  }
  const folded = new Map<string, LogEntry>()
  for (const entry of entries) {
    const key = `${entry.level}\u0000${entry.message}`
    const seen = folded.get(key)
    if (seen) {
      seen.count += 1
      if (entry.at && (!seen.at || entry.at > seen.at)) {
        seen.at = entry.at
        seen.raw = entry.raw
      }
    } else {
      folded.set(key, { ...entry, count: 1 })
    }
  }
  return [...folded.values()].sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))
}

export function isError(level: string): boolean {
  return level === 'ERROR' || level === 'CRITICAL'
}

/** Error lines stamped today (local time), counted before folding. */
export function errorsToday(lines: readonly string[], now: Date = new Date()): number {
  let n = 0
  for (const line of lines) {
    const parsed = parseOne(line)
    if (!parsed || !isError(parsed.level) || !parsed.at) continue
    if (parsed.at.toDateString() === now.toDateString()) n += 1
  }
  return n
}

/** How bad, as a `msg()` key and a tone. */
export function levelWord(level: string): { word: string; tone: Tone } {
  if (isError(level)) return { word: msg('error'), tone: 'bad' }
  if (level === 'WARNING' || level === 'WARN') return { word: msg("warning"), tone: 'warn' }
  if (level === 'DEBUG') return { word: msg("debug"), tone: 'off' }
  return { word: msg('info'), tone: 'none' }
}

const SOURCE: Record<string, string> = {
  downloads: msg("downloads"),
  metadata: msg("metadata"),
  lyrics: msg("lyrics"),
  playlists: msg('playlists'),
  browse: msg("browse"),
  stems: msg('Stems'),
  accounts: msg("accounts"),
  music: msg("library"),
  transfers: msg("transfers"),
}

/** Where it came from, as a `msg()` key: the domain, else "servidor". */
export function sourceWord(module: string): string {
  const domain = /^app\.domains\.(\w+)/.exec(module)?.[1]
  return (domain && SOURCE[domain]) || msg("nest")
}
