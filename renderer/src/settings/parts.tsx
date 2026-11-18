/**
 * The pieces every Settings section is drawn with: the block (one ink sheet per
 * job), its four states (loading skeleton · error with "Retry" · empty ·
 * older nest), the dot-and-word status mark, the switch, the segmented
 * control, the dialog and the one toast that offers "undo".
 */
import { createContext, useCallback, useContext, useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy } from 'lucide-react'
import { dismissNotification, notify } from '../ui/notifications'
import { isOlderNest } from './data'
import { isForbidden } from '../data'
import { useDismissLayer } from '../ui/react/components/useDismissLayer'
import { useFocusTrap } from '../ui/react/components/useFocusTrap'
import { formatCount } from './format'
import { Missing } from '../ui/react/components/Missing'

/* ───────────────────────────── states ───────────────────────────── */

const SKEL_WIDTHS = [86, 64, 74, 52]

/** Loading: bars shaped like the block's rows. No spinner. */
export function Skel({ rows = 2, label }: { rows?: number; label?: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="settings-skel" role="status" aria-label={label ?? t("Loading…")}>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} style={{ width: `${SKEL_WIDTHS[i % SKEL_WIDTHS.length]}%` }} />
      ))}
    </div>
  )
}

/** Error: why, in words, and the one way out. */
export function ErrorAlt({ what, onRetry }: { what: string; onRetry: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="settings-alt" role="alert">
      <span className="settings-dotw settings-dotw--bad" />
      <span className="z-say">{t("Could not load {{what}}.", { what })}</span>
      <button className="z-btn z-btn--sm" type="button" onClick={onRetry}>
        {t("Retry")}
      </button>
    </div>
  )
}

/** A nest older than the route: a muted version note, never an error. */
export function OldNest({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="settings-alt settings-alt--panel-2">
      <span className="z-say settings-alt__line">{children}</span>
    </div>
  )
}

/** A completed request always has a terminal state, including missing routes. */
export function QueryFailure({ error, what, older, onRetry, forbiddenAsOlder = false }: { error: unknown; what: string; older?: string; onRetry: () => void; forbiddenAsOlder?: boolean }): React.JSX.Element {
  const { t } = useTranslation()
  return isOlderNest(error) || (forbiddenAsOlder && isForbidden(error))
    ? <OldNest>{older ?? t("Update the nest to use this feature.")}</OldNest>
    : <ErrorAlt what={what} onRetry={onRetry} />
}

/** Missing or invalid counters are unknown, never zero or NaN. */
export function Count({ value, reason }: { value: number | null | undefined; reason?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const known = typeof value === 'number' && Number.isFinite(value) && value >= 0
  return known ? <b className="z-mono">{formatCount(value)}</b> : <Missing kind="nodata" reason={reason ?? t("The nest did not send the data to calculate it.")} />
}

/** Empty: what is true, and (when there is one) the next action. */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }): React.JSX.Element {
  return (
    <div className="settings-alt settings-alt--empty">
      {typeof children === 'string' ? <span className="z-say settings-alt__line">{children}</span> : children}
      {action}
    </div>
  )
}

/* ───────────────────────────── marks ───────────────────────────── */

export type Tone = 'ok' | 'warn' | 'bad' | 'off' | 'none'

export function Dot({ tone = 'none' }: { tone?: Tone }): React.JSX.Element {
  return <span className={`settings-dotw${tone === 'ok' || tone === 'warn' || tone === 'bad' ? ` settings-dotw--${tone}` : ''}`} />
}

/** Status as dot + word, never colour alone. */
export function Word({ tone = 'none', children, title }: { tone?: Tone; children: ReactNode; title?: string }): React.JSX.Element {
  return (
    <span className={`settings-word${tone !== 'none' ? ` settings-word--${tone}` : ''}`} title={title}>
      {tone === 'ok' || tone === 'warn' || tone === 'bad' ? <Dot tone={tone} /> : null}
      {children}
    </span>
  )
}

/** A term whose consequence is not obvious: dotted underline + tooltip. */
export function Tipped({ tip, children }: { tip: string; children: ReactNode }): React.JSX.Element {
  return (
    <span className="settings-tipped" title={tip} tabIndex={0}>
      {children}
    </span>
  )
}

/* ───────────────────────────── controls ───────────────────────────── */

export function Switch({
  checked,
  onChange,
  label,
  title,
  disabled,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  title?: string
  disabled?: boolean
}): React.JSX.Element {
  return (
    <label className="ks-sw" title={title}>
      <input
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span />
    </label>
  )
}

export function Seg<V extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: readonly { value: V; label: string; title?: string }[]
  value: V
  onChange: (value: V) => void
}): React.JSX.Element {
  return (
    <div className="ks-seg" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    const clipboard = globalThis.navigator?.clipboard
    if (clipboard === undefined) return false
    await clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Copies a value; says so in the toast, never by quoting it. */
export function CopyButton({ value, label }: { value: string; label?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const name = label ?? t("Copy")
  return (
    <button
      className="z-btn z-btn--xs z-btn--icon z-btn--ghost"
      type="button"
      aria-label={name}
      title={name}
      onClick={() => {
        void copyToClipboard(value).then((ok) => toast(ok ? t("Copied") : t("Could not copy"), { err: !ok }))
      }}
    >
      <Copy className="i" aria-hidden />
    </button>
  )
}

/* ───────────────────────────── dialog ───────────────────────────── */

/** Keep this dialog inside the Settings token scope and reuse shared focus/dismissal hooks.
 * The caller can refuse dismissal while a request is pending. */
export function Modal({
  title,
  onClose,
  children,
  className,
  profile,
  heading,
  busy = false,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  className?: string
  profile?: 'modern'
  heading?: (titleId: string) => ReactNode
  busy?: boolean
}): React.JSX.Element {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)

  useFocusTrap(panel, true, { modal: true })
  useDismissLayer(panel, true, { onEscape: onClose, onOutsidePress: onClose })

  useEffect(() => {
    if (busy) panel.current?.focus()
  }, [busy])

  return (
    <div className="z-scrim">
      <div
        ref={panel}
        className={`z-modal settings-modal${className ? ` ${className}` : ''}`}
        data-profile={profile}
        data-tone={profile ? 'calm' : undefined}
        data-state="open"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        {heading ? heading(titleId) : <h3 id={titleId}>{title}</h3>}
        {children}
      </div>
    </div>
  )
}

/* ───────────────────────────── toast ───────────────────────────── */

export interface ToastOptions {
  /** Offered as "undo" for about six seconds. */
  undo?: () => void
  /** Deferred destructive work runs only after its full visible undo window. */
  onExpire?: () => void
  /** Replacing the toast or closing Settings cancels deferred work. */
  onDismiss?: () => void
  err?: boolean
}

type ToastFn = (text: string, options?: ToastOptions) => void

const ToastContext = createContext<ToastFn>(() => {})

export function useToast(): ToastFn {
  return useContext(ToastContext)
}

/**
 * Settings' toast: act, then offer "Undo". Drawn by the app's one
 * notification channel (ui/notifications); this keeps Settings' rules on
 * top of it; one at a time (a new one replaces the last and cancels its
 * deferred work), about six seconds, and closing Settings cancels too.
 */
export function ToastProvider({ children }: { children: ReactNode; className?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const active = useRef<{ id: string; options: ToastOptions } | null>(null)

  const toast = useCallback<ToastFn>((text, options = {}) => {
    const previous = active.current
    if (previous) {
      active.current = null
      dismissNotification(previous.id)
      previous.options.onDismiss?.()
    }
    const entry: { id: string; options: ToastOptions } = { id: '', options }
    entry.id = notify({
      level: options.err ? 'error' : 'success',
      message: text,
      durationMs: TOAST_MS,
      action: options.undo
        ? { label: t("Undo"), onSelect: () => { if (active.current === entry) active.current = null; options.undo?.() } }
        : undefined,
      onExpire: options.onExpire || options.onDismiss
        ? () => { if (active.current === entry) active.current = null; options.onExpire?.() }
        : undefined,
    })
    active.current = entry
  }, [t])

  useEffect(
    () => () => {
      const entry = active.current
      active.current = null
      if (entry) {
        dismissNotification(entry.id)
        entry.options.onDismiss?.()
      }
    },
    [],
  )

  return <ToastContext.Provider value={toast}>{children}</ToastContext.Provider>
}

/** How long an Settings toast (and its undo window) stays. */
const TOAST_MS = 6000
