/** Format decimal byte units and device timestamps in the current UI language at render time. */
import i18n from '../i18n'

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** Decimal units, as the Finder and every disk label count them. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit += 1
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1
  const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: digits }).format(value)
  return `${number} ${UNITS[unit]}`
}

/** A count in the language's grouping ("1.234"). */
export function formatCount(n: number): string {
  return Number.isFinite(n) && n >= 0 ? new Intl.NumberFormat(i18n.language).format(n) : '—'
}

const MINUTE = 60_000
const DAY = 86_400_000

function startOfDay(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()
}

/**
 * A last sighting. `null` is "never"; a device minted and never opened has
 * none, which is an answer, not missing data.
 */
export function formatSeen(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return i18n.t("never")
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  if (now.getTime() - at.getTime() < 2 * MINUTE) return i18n.t("now")
  const time = new Intl.DateTimeFormat(i18n.language, { hour: 'numeric', minute: '2-digit' }).format(at)
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY)
  if (days === 0) return i18n.t("today, {{time}}", { time })
  if (days === 1) return i18n.t("yesterday, {{time}}", { time })
  return formatDay(at, now)
}

/** "24 oct", with the year only when it is not this one. */
export function formatDay(at: Date, now: Date = new Date()): string {
  return new Intl.DateTimeFormat(i18n.language, {
    day: 'numeric',
    month: 'short',
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
    .format(at)
    .replace('.', '')
}

/** "hace 10 s", "hace 5 min", "hace 2 h", for something this app checked. */
export function formatAgo(ms: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000))
  if (seconds < 60) return i18n.t("{{n}} s ago", { n: seconds })
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return i18n.t("{{n}} min ago", { n: minutes })
  return i18n.t("{{n}} h ago", { n: Math.round(minutes / 60) })
}

/** An address without its scheme or trailing slash: `192.168.1.20:8000`. */
export function bareHost(url: string | null | undefined): string {
  return (url ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '')
}
