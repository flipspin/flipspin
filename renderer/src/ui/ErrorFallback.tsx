import { Component, useEffect, useRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import i18n from '../i18n'
import type { ErrorFallbackState } from './ErrorBoundary'
import { describeError, logger } from '../lib/logger'
import { button, primaryButton, surface } from './styles'

const RETRY_LIMIT = 3

function reloadWindow(): void {
  // The last resort that cannot itself fail from application state: throw the
  // renderer away and boot it again.
  window.location.reload()
}

/** Keep the final fallback static so broken app state or providers cannot crash it. */
export function MinimalFallback(): React.JSX.Element {
  // `i18n.t`, not the hook: this component must depend on nothing that can
  // fail, and a plain lookup that answers the key on any miss qualifies.
  return (
    <div role="alert" style={{ ...surface, margin: 16, padding: 16 }}>
      <p style={{ marginTop: 0 }}>
        {i18n.t("The app can't show this screen. Reload to start over.")}
      </p>
      <button type="button" onClick={reloadWindow} style={primaryButton}>
        {i18n.t("Reload the app")}
      </button>
    </div>
  )
}

/**
 * Catches a throw coming from a fallback.
 *
 * Separate from `ErrorBoundary` on purpose: a boundary cannot catch its own
 * fallback, because that fallback is part of the render the boundary itself is
 * performing. Only a boundary *below* it can.
 */
export class FallbackGuard extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(error: unknown): void {
    logger.error('error boundary fallback crashed', describeError(error))
  }

  override render(): ReactNode {
    return this.state.failed ? <MinimalFallback /> : this.props.children
  }
}

/** Invoke the render prop inside FallbackGuard so errors occur below the guard
 * instead of during the parent boundary's render. */
export function FallbackRenderer({
  render,
  state,
}: {
  render: (state: ErrorFallbackState) => ReactNode
  state: ErrorFallbackState
}): React.JSX.Element {
  return <>{render(state)}</>
}

/** The default fallback: honest about what happened, and always a way out. */
export function DefaultFallback({
  error,
  failures,
  retry,
  returnHome,
  area,
}: ErrorFallbackState & { area?: string | undefined }): React.JSX.Element {
  const { t } = useTranslation()
  const heading = useRef<HTMLHeadingElement | null>(null)

  useEffect(() => {
    // Move focus into the replacement screen because the previously focused node no longer exists.
    heading.current?.focus()
  }, [])

  const retryIsHopeless = failures >= RETRY_LIMIT

  return (
    <div role="alert" style={{ ...surface, margin: 16, maxWidth: 560, padding: 20 }}>
      <h2 ref={heading} tabIndex={-1} style={{ fontSize: 18, marginTop: 0, outline: 'none' }}>
        {area ? t("Something broke in {{area}}", { area }) : t("Something broke on this screen")}
      </h2>
      <p>
        {retryIsHopeless
          ? t("Retrying isn't working. Reload the app; your music and your playlists haven't been touched.")
          : t("The rest of the app keeps working. You can try again or go back to Home.")}
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {!retryIsHopeless && (
          <button type="button" onClick={retry} style={primaryButton}>
            {t("Retry")}
          </button>
        )}
        {returnHome && (
          <button type="button" onClick={returnHome} style={button}>
            {t("Back to Home")}
          </button>
        )}
        <button type="button" onClick={reloadWindow} style={button}>
          {t("Reload the app")}
        </button>
      </div>

      {/* The message, verbatim. A user copying this into a bug report is worth
          more than a screen that pretends nothing technical happened. */}
      <details style={{ marginTop: 16 }}>
        <summary style={{ cursor: 'pointer' }}>{t("Technical details")}</summary>
        <pre style={{ fontSize: 12, margin: '8px 0 0', overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
          {error.message || error.name}
        </pre>
      </details>
    </div>
  )
}
