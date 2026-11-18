/**
 * Layout for the pairing panels, against the design system.
 *
 * `secretField` is the only style in the app with a reason that is not visual:
 * a pairing code is read off the screen and typed into a phone, so it is set in
 * the mono face at a size that survives being read at arm's length, and it wraps
 * rather than truncating. A code with an ellipsis in it is not a code.
 */

import type { CSSProperties } from 'react'

export const panel: CSSProperties = { display: 'grid', gap: '0.75rem' }
export const stack: CSSProperties = { display: 'grid', gap: '0.6rem' }
export const row: CSSProperties = { display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }

export const table: CSSProperties = { borderCollapse: 'collapse', width: '100%', textAlign: 'left' }
export const cell: CSSProperties = { padding: '7px 10px', borderBottom: '1px solid var(--line-soft)' }
export const headerCell: CSSProperties = { ...cell, borderBottom: '1.5px solid var(--line)' }

export const dialog: CSSProperties = {
  display: 'grid',
  gap: '0.75rem',
  padding: '14px 16px',
  background: 'var(--panel)',
  border: '1.5px solid var(--line)',
  borderRadius: 'var(--r-md)',
  boxShadow: 'var(--pop)',
}

export const notice: CSSProperties = {
  padding: '10px 12px',
  border: '1.5px solid var(--line-med)',
  borderRadius: 'var(--r-sm)',
  background: 'var(--panel-2)',
}

export const warning: CSSProperties = {
  ...notice,
  borderColor: 'var(--warn)',
  background: 'var(--warn-tint)',
}

export const secretField: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '1rem',
  letterSpacing: '0.04em',
  padding: '10px 12px',
  background: 'var(--yellow-tint)',
  border: '1.5px solid var(--line)',
  borderRadius: 'var(--r-sm)',
  wordBreak: 'break-all',
  userSelect: 'all',
}

export const muted: CSSProperties = { color: 'var(--ink-3)' }

export const qrFrame: CSSProperties = {
  padding: 10,
  background: '#ffffff',
  border: '1.5px solid var(--line)',
  borderRadius: 'var(--r-sm)',
  width: 'fit-content',
}
