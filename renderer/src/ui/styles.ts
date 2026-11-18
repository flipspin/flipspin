/** Keep fallback structure inline so error boundaries remain usable if styles fail to load.
 * Use token colors with literal fallbacks for a missing token layer. */

import type { CSSProperties } from 'react'

import { msg } from '../i18n'

export type Severity = 'info' | 'success' | 'warning' | 'error'

/** Border and text colour per severity. Text is the accessible pair, not the fill. */
export const SEVERITY_COLOR: Record<Severity, { accent: string; text: string }> = {
  info: { accent: 'var(--blue, #2e5bff)', text: 'var(--ink, #151515)' },
  success: { accent: 'var(--ok, #5a9f5c)', text: 'var(--ink, #151515)' },
  warning: { accent: 'var(--warn, #c98a10)', text: 'var(--ink, #151515)' },
  error: { accent: 'var(--danger, #d14b6a)', text: 'var(--ink, #151515)' },
}

/** What each severity is called on screen. Spanish, like everything the user reads. */
// `msg()` keys: rendered through `t()` by notifications.tsx.
export const SEVERITY_LABEL: Record<Severity, string> = {
  info: msg("Information"),
  success: msg("Done"),
  warning: msg("Warning"),
  error: msg('Error'),
}

export const surface: CSSProperties = {
  background: 'var(--panel, #fffef7)',
  border: '1.5px solid var(--line, #151515)',
  borderRadius: 'var(--r-md, 10px)',
  // The hard offset shadow, spent here because a toast and an error boundary are
  // genuinely above the page rather than part of it.
  boxShadow: 'var(--pop, 3px 3px 0 #151515)',
  color: 'var(--ink, #151515)',
  fontFamily: "var(--font-ui, var(--font-main))",
  fontSize: 14,
  lineHeight: 1.5,
}

export const button: CSSProperties = {
  background: 'var(--panel, #fffef7)',
  border: '1.5px solid var(--line, #151515)',
  borderRadius: 'var(--r-sm, 6px)',
  color: 'var(--ink, #151515)',
  cursor: 'pointer',
  font: 'inherit',
  fontWeight: 600,
  padding: '5px 11px',
}

export const primaryButton: CSSProperties = {
  ...button,
  background: 'var(--yellow, #ef7e55)',
  boxShadow: 'var(--pop-sm, 2px 2px 0 #151515)',
}
