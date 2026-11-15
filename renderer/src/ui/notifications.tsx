/** Share notifications across legacy status and Settings toast adapters.
 * Expose an imperative entry point for query handlers, services and IPC listeners that cannot call hooks. */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'

import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

import { getLayerRoot } from './react/components/layerRoot'

import { logger } from '../lib/logger'
import { SEVERITY_COLOR, SEVERITY_LABEL, button, surface, type Severity } from './styles'

export type NotificationLevel = Severity

export type NotificationAction = { label: string; onSelect: () => void; dismiss?: boolean }

export interface NotifyOptions {
  /** reportError already wrote the full diagnostic. */
  logged?: boolean
  /** A stable id replaces the current entry, including its action. */
  id?: string
  /** Defaults to `info`. */
  level?: NotificationLevel
  /** Optional headline. The message alone is enough for most cases. */
  title?: string
  message: string
  /** Overrides the level's default. Errors are sticky; everything else expires. */
  sticky?: boolean
  /** Overrides the level's default lifetime, in milliseconds. */
  durationMs?: number
  /** Deferred work starts after the notification has been visible for its lifetime. */
  onExpire?: () => void
  /** One thing the user can do about it, e.g. "Retry". */
  action?: NotificationAction
  secondaryAction?: NotificationAction
}

export interface AppNotification {
  id: string
  level: NotificationLevel
  title: string | null
  message: string
  sticky: boolean
  durationMs: number
  action: NotificationAction | null
  secondaryAction: NotificationAction | null
  /** How many times this exact message arrived. See the dedupe note in `merge`. */
  onExpire?: () => void
  repeats: number
}

/** Keep errors visible until dismissed so actionable failures cannot expire unread. */
const DEFAULT_DURATION_MS: Record<NotificationLevel, number> = {
  info: 5000,
  success: 4000,
  warning: 8000,
  error: 0,
}

/** How many are on screen at once. The rest wait; they are not dropped. */
const MAX_VISIBLE = 3
/** Hard ceiling on the backlog, so a failing loop cannot grow an unbounded list. */
const MAX_TOTAL = 12
/** Ceiling on what can be held before any provider has mounted. */
const MAX_BUFFERED = 20

let sequence = 0

function createNotification(options: NotifyOptions): AppNotification {
  const level = options.level ?? 'info'
  sequence += 1
  return {
    id: options.id ?? `notification-${sequence}`,
    level,
    title: options.title ?? null,
    message: options.message,
    sticky: options.sticky ?? level === 'error',
    durationMs: options.durationMs ?? DEFAULT_DURATION_MS[level],
    action: options.action ?? null,
    secondaryAction: options.secondaryAction ?? null,
    onExpire: options.onExpire,
    repeats: 1,
  }
}

interface NotificationSink {
  push: (notification: AppNotification) => void
  dismiss: (id: string) => void
  dismissAll: () => void
}

let sink: NotificationSink | null = null
const buffered: AppNotification[] = []

/** Check sink identity on disconnect so Strict Mode cleanup cannot remove a newer provider. */
function connectSink(next: NotificationSink): () => void {
  sink = next
  // Deliver buffered startup notifications once the provider mounts.
  const backlog = buffered.splice(0, buffered.length)
  for (const notification of backlog) next.push(notification)

  return () => {
    if (sink === next) sink = null
  }
}

/**
 * Raise a notification from anywhere, component or not. Returns its id.
 *
 * Callable before the provider mounts: the notification is buffered and shown as
 * soon as there is somewhere to show it.
 */
export function notify(options: NotifyOptions): string {
  const notification = createNotification(options)

  // Anything shown to the user as a failure belongs in the log file too. The
  // screen is transient and the user will not transcribe it into a bug report.
  if (!options.logged && (notification.level === 'error' || notification.level === 'warning')) {
    logger.write(notification.level === 'error' ? 'error' : 'warn', notification.message, {
      title: notification.title,
    })
  }

  if (sink) {
    sink.push(notification)
    return notification.id
  }

  if (buffered.length >= MAX_BUFFERED) {
    const dropped = buffered.shift()
    logger.warn('notification dropped: nothing is mounted to show it', {
      message: dropped?.message ?? null,
    })
  }
  const previous = buffered.findIndex(item => item.id === notification.id)
  if (previous >= 0) buffered.splice(previous, 1)
  buffered.push(notification)
  return notification.id
}

export function dismissNotification(id: string): void {
  sink?.dismiss(id)
}

export function dismissAllNotifications(): void {
  sink?.dismissAll()
  buffered.length = 0
}

/** Fold identical messages into a repeat count so repeated failures cannot fill the notification stack. */
function merge(list: readonly AppNotification[], incoming: AppNotification): AppNotification[] {
  if (list.some(item => item.id === incoming.id)) return list.map(item => item.id === incoming.id ? incoming : item)
  const duplicate = list.find(
    (item) => !incoming.onExpire && !item.onExpire && !incoming.action && !item.action && !incoming.secondaryAction && !item.secondaryAction
      && item.level === incoming.level && item.message === incoming.message && item.title === incoming.title,
  )
  if (duplicate) {
    return list.map((item) => (item.id === duplicate.id ? { ...item, repeats: item.repeats + 1 } : item))
  }

  const next = [...list, incoming]
  if (next.length <= MAX_TOTAL) return next

  // Over the ceiling: drop the oldest expiring one. A sticky notification is
  // only removed when nothing else can go, since it is the kind the user was
  // asked to act on.
  const victim = next.find((item) => !item.sticky) ?? next[0]
  return victim ? next.filter((item) => item !== victim) : next
}

interface NotificationsContextValue {
  notifications: readonly AppNotification[]
  notify: (options: NotifyOptions) => string
  dismiss: (id: string) => void
  dismissAll: () => void
}

/**
 * The default is a working value, not a throw.
 *
 * A component that reports a failure outside the provider would otherwise crash
 * *because* it tried to report a failure. Outside a provider these forward to
 * the module-level functions, which buffer and log.
 */
const NotificationsContext = createContext<NotificationsContextValue>({
  notifications: [],
  notify,
  dismiss: dismissNotification,
  dismissAll: dismissAllNotifications,
})

export function useNotifications(): NotificationsContextValue {
  return useContext(NotificationsContext)
}

const regionStyle: CSSProperties = {
  // Top right, under the header: the bottom edge is the player's controls.
  top: 72,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  maxWidth: 420,
  position: 'fixed',
  right: 16,
  width: 'calc(100vw - 32px)',
  // Above dialogs and menus: a message raised from inside Settings or a modal
  // must not open underneath it.
  zIndex: 'var(--z-toast, 1200)' as unknown as number,
}

const listStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  listStyle: 'none',
  margin: 0,
  padding: 0,
}

function NotificationItem({
  notification,
  onDismiss,
}: {
  notification: AppNotification
  onDismiss: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { id, level, title, message, sticky, durationMs, action, secondaryAction, repeats, onExpire } = notification

  useEffect(() => {
    if (sticky || durationMs <= 0) return
    // Start expiry only when visible so queued notifications retain reading time.
    // Restart the countdown for repeats because the message has become relevant again.
    const timer = window.setTimeout(() => { onExpire?.(); onDismiss(id) }, durationMs)
    return () => {
      window.clearTimeout(timer)
    }
  }, [durationMs, id, onDismiss, onExpire, repeats, sticky])

  const colors = SEVERITY_COLOR[level]

  return (
    <li style={{ ...surface, borderLeft: `4px solid ${colors.accent}`, padding: '10px 12px' }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ color: colors.text, fontWeight: 600, margin: 0 }}>
            {t(SEVERITY_LABEL[level])}
            {repeats > 1 ? ` ×${repeats}` : ''}
          </p>
          {title && <p style={{ fontWeight: 600, margin: '2px 0 0' }}>{title}</p>}
          <p style={{ margin: '2px 0 0', overflowWrap: 'anywhere' }}>{message}</p>
          {[action, secondaryAction].filter((item): item is NotificationAction => !!item).map((item, index) => (
            <button
              key={index}
              type="button"
              onClick={() => {
                item.onSelect()
                if (item.dismiss !== false) onDismiss(id)
              }}
              style={{ ...button, marginTop: 8, marginRight: 8 }}
            >
              {item.label}
            </button>
          ))}
        </div>
        {/* The message is in the accessible name because there can be three of
            these at once, and "Descartar" three times over tells a screen reader
            user nothing about which one they are on. */}
        <button
          type="button"
          aria-label={t("Dismiss: {{message}}", { message })}
          // Closing a deferred-action toast ends its undo window as well.
          onClick={() => { onExpire?.(); onDismiss(id) }}
          style={{ ...button, alignSelf: 'flex-start', lineHeight: 1, padding: '2px 8px' }}
        >
          ×
        </button>
      </div>
    </li>
  )
}

function NotificationRegion({
  notifications,
  onDismiss,
}: {
  notifications: readonly AppNotification[]
  onDismiss: (id: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const visible = notifications.slice(0, MAX_VISIBLE)
  const waiting = notifications.length - visible.length
  const polite = visible.filter((item) => item.level === 'info' || item.level === 'success')
  const assertive = visible.filter((item) => item.level === 'warning' || item.level === 'error')

  return (
    <div data-krobi-notifications="" data-krobi-modal-branch="" style={regionStyle}>
      {/* Mount live regions before messages arrive so assistive technology observes their mutations.
       * Keep errors assertive and confirmations polite in separate regions. */}
      <ul aria-label={t("Notifications")} aria-live="polite" style={listStyle}>
        {polite.map((item) => (
          <NotificationItem key={item.id} notification={item} onDismiss={onDismiss} />
        ))}
      </ul>
      <ul aria-label={t("Alerts")} aria-live="assertive" style={listStyle}>
        {assertive.map((item) => (
          <NotificationItem key={item.id} notification={item} onDismiss={onDismiss} />
        ))}
      </ul>
      {waiting > 0 && (
        // Deliberately outside both live regions: it is a visual hint about the
        // backlog, and announcing "quedan 2" after every dismissal is noise.
        <p style={{ color: '#3f3f46', fontFamily: 'system-ui, sans-serif', fontSize: 12, margin: 0 }}>
          {t("{{n}} more messages waiting", { count: waiting, n: waiting })}
        </p>
      )}
    </div>
  )
}

export function NotificationsProvider({ children }: { children?: ReactNode }): React.JSX.Element {
  const [notifications, setNotifications] = useState<readonly AppNotification[]>([])

  const dismiss = useCallback((id: string) => {
    setNotifications((list) => list.filter((item) => item.id !== id))
  }, [])

  const dismissAll = useCallback(() => {
    setNotifications([])
  }, [])

  useEffect(
    () =>
      connectSink({
        push: (notification) => setNotifications((list) => merge(list, notification)),
        dismiss: (id) => setNotifications((list) => list.filter((item) => item.id !== id)),
        dismissAll: () => setNotifications([]),
      }),
    [],
  )

  const value = useMemo<NotificationsContextValue>(
    () => ({ notifications, notify, dismiss, dismissAll }),
    [notifications, dismiss, dismissAll],
  )

  return (
    <NotificationsContext.Provider value={value}>
      {children}
      {/* In the persistent layer root, beside the dialogs, so it stacks above
          them (layerRoot.ts); before that root exists, in place. */}
      {(() => {
        const region = <NotificationRegion notifications={notifications} onDismiss={dismiss} />
        const root = typeof document === 'undefined' ? null : getLayerRoot()
        return root ? createPortal(region, root) : region
      })()}
    </NotificationsContext.Provider>
  )
}
