/**
 * The renderer's error and notification surface.
 *
 * Everything a screen needs to report a failure, ask a question or survive a
 * crash. Import from here rather than from the individual modules, so the layout
 * of this directory stays an implementation detail.
 */

export { ErrorBoundary, type ErrorBoundaryProps, type ErrorFallbackState } from './ErrorBoundary'
export { UiProvider, type UiProviderProps } from './UiProvider'

export {
  NotificationsProvider,
  dismissAllNotifications,
  dismissNotification,
  notify,
  useNotifications,
  type AppNotification,
  type NotificationLevel,
  type NotifyOptions,
} from './notifications'

export { ConfirmProvider, confirmAction, useConfirm, type ConfirmOptions } from './confirm'

export { describeError, isLogBridgeAvailable, logger, type LogContext } from '../lib/logger'
