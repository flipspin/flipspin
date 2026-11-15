/** Keep notifications outside the error boundary so failures retain a working feedback surface.
 * Fallbacks stay independent of app contexts because a provider may be the source of the crash. */

import type { ReactNode } from 'react'

import { ConfirmProvider } from './confirm'
import { ErrorBoundary } from './ErrorBoundary'
import { NotificationsProvider } from './notifications'

export interface UiProviderProps {
  children: ReactNode
  /** Passed through to the root boundary; where "Back to Home" should land. */
  onReturnHome?: () => void
  /** Passed through to the root boundary. Usually the current route key. */
  resetKeys?: readonly unknown[]
}

export function UiProvider({ children, onReturnHome, resetKeys }: UiProviderProps): React.JSX.Element {
  return (
    <NotificationsProvider>
      <ConfirmProvider>
        <ErrorBoundary onReturnHome={onReturnHome} resetKeys={resetKeys}>
          {children}
        </ErrorBoundary>
      </ConfirmProvider>
    </NotificationsProvider>
  )
}
