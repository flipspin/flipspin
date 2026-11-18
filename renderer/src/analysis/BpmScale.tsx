import { useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useCurrentUser } from '../data'
import './analysis.css'

import { scaledBpm, type BpmFactor } from './bpm'
export type { BpmFactor } from './bpm'

/** Preview the exact correction before saving it, including in accessible names. */
export function BpmScale({ bpm, disabled, song, onScale }: { bpm: unknown; disabled?: boolean; song?: string; onScale: (value: number, factor: BpmFactor) => void }) {
  const { t } = useTranslation()
  const me = useCurrentUser()
  const root = useRef<HTMLSpanElement>(null)
  const focus = useRef<BpmFactor | null>(null)
  useLayoutEffect(() => {
    if (disabled || focus.current === null) return
    const button = root.current?.querySelector<HTMLButtonElement>(`[data-factor="${focus.current}"]:not(:disabled)`)
      ?? root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')
    focus.current = null
    button?.focus({ preventScroll: true })
  }, [disabled, bpm])
  if (!me.data?.isOwner) return null
  const missing = typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm <= 0
  return <span ref={root} className="analysis-bpm-scale">
    {([0.5, 2] as const).map(factor => {
      const value = scaledBpm(bpm, factor)
      if (!missing && value === null) return null
      const glyph = factor === 2 ? '×2' : '½'
      const label = value === null ? t("Not analyzed") : t(factor === 2 ? "Double BPM to {{value}}" : "Halve BPM to {{value}}", { value })
      return <button key={factor} type="button" className="k-btn" data-factor={factor} title={value === null ? label : `${glyph} → ${value}`} aria-label={song ? `${label} · ${song}` : label} disabled={disabled || value === null}
        onMouseDown={event => event.preventDefault()} onClick={event => {
          if (value === null) return
          if (document.activeElement === event.currentTarget) focus.current = factor
          onScale(value, factor)
        }}>{glyph}</button>
    })}
  </span>
}
