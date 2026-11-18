import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Portal } from './Portal'
import { useDismissLayer } from './useDismissLayer'
import './tooltip.css'

/** Focusable, portalled tooltip shared by compact data marks. Never takes focus
 * from its trigger; Escape dismisses it before any containing dialog. */
export function Tooltip({ children, content, label, className = '' }: { children: ReactNode; content: ReactNode; label: string; className?: string }) {
  const id = useId()
  const anchor = useRef<HTMLSpanElement>(null)
  const panel = useRef<HTMLSpanElement>(null)
  const [tabIndex, setTabIndex] = useState(0)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  // A mark inside a select/button shares that control's focus stop.
  useLayoutEffect(() => {
    const control = anchor.current?.parentElement?.closest<HTMLElement>('button, a[href], [tabindex="0"]') ?? anchor.current?.querySelector<HTMLElement>('input, button, select, textarea')
    if (!control) return
    setTabIndex(-1)
    const show = () => setOpen(true), hide = () => setOpen(false)
    control.addEventListener('focus', show)
    control.addEventListener('blur', hide)
    return () => { control.removeEventListener('focus', show); control.removeEventListener('blur', hide) }
  }, [])
  useLayoutEffect(() => {
    const control = anchor.current?.parentElement?.closest<HTMLElement>('button, a[href], [tabindex="0"]') ?? anchor.current?.querySelector<HTMLElement>('input, button, select, textarea')
    if (!control || !open) return
    const previous = control.getAttribute('aria-describedby')
    control.setAttribute('aria-describedby', [previous, id].filter(Boolean).join(' '))
    return () => { if (previous) control.setAttribute('aria-describedby', previous); else control.removeAttribute('aria-describedby') }
  }, [open, id])
  useDismissLayer(panel, open, { onEscape: () => setOpen(false), onOutsidePress: () => setOpen(false), branches: [anchor] })
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const a = anchor.current?.getBoundingClientRect(), b = panel.current?.getBoundingClientRect()
      if (!a || !b) return
      setPosition({ left: Math.max(8, Math.min(a.left, window.innerWidth - b.width - 8)), top: a.bottom + b.height + 8 <= window.innerHeight ? a.bottom + 6 : Math.max(8, a.top - b.height - 6) })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place) }
  }, [open, content])
  return <span ref={anchor} className={`k-tooltip-trigger ${className}`} tabIndex={tabIndex} aria-label={label}
    onMouseEnter={() => setOpen(true)} onMouseLeave={() => { if (!anchor.current?.contains(document.activeElement)) setOpen(false) }}
    onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
    {children}
    {open ? <Portal><span ref={panel} id={id} role="tooltip" className="k-tooltip" style={position}>{content}</span></Portal> : null}
  </span>
}
