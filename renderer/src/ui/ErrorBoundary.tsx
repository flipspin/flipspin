/** Remount on retry so broken component state is discarded.
 * Guard the fallback separately with static markup because a fallback crash otherwise
 * propagates to the parent boundary and can blank the window. */

import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'

import { describeError, logger } from '../lib/logger'
import { DefaultFallback, FallbackGuard, FallbackRenderer } from './ErrorFallback'

export interface ErrorFallbackState {
  error: Error
  /** Consecutive catches by this boundary. `>= 3` means retrying is not working. */
  failures: number
  /** Clears the error and remounts the subtree. */
  retry: () => void
  /** Present only when the host gave the boundary somewhere known-good to send the user. */
  returnHome?: (() => void) | undefined
}

export interface ErrorBoundaryProps {
  children: ReactNode
  /**
   * What broke, in words, e.g. "the library". Goes into the log and into the
   * copy, because "esta pantalla" is not actionable when three panels are open.
   */
  area?: string
  /**
   * Changing any entry clears the error. Pass the route key: without it, a
   * boundary that caught once stays in its fallback forever, and navigating away
   * from the broken screen keeps showing the error for the screen just left.
   */
  resetKeys?: readonly unknown[]
  /** Somewhere known-good to send the user. Usually the router's "go home". */
  onReturnHome?: () => void
  /** For the host to add its own reporting. A throw here is swallowed, not propagated. */
  onError?: (error: Error, componentStack: string | null) => void
  /** Replaces the default fallback. Rendered inside the guard, like the default one. */
  fallback?: (state: ErrorFallbackState) => ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
  failures: number
  /** Bumped on every retry and used as the children's key; see `retry`. */
  resetIndex: number
}

function keysChanged(previous: readonly unknown[] | undefined, next: readonly unknown[] | undefined): boolean {
  if (previous === next) return false
  if (!previous || !next) return true
  if (previous.length !== next.length) return true
  return previous.some((value, index) => !Object.is(value, next[index]))
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, failures: 0, resetIndex: 0 }

  static getDerivedStateFromError(error: Error): Pick<ErrorBoundaryState, 'error'> {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? null
    this.setState((previous) => ({ failures: previous.failures + 1 }))

    logger.error('render error caught by boundary', {
      area: this.props.area ?? null,
      componentStack,
      ...describeError(error),
    })

    try {
      this.props.onError?.(error, componentStack)
    } catch (hostError) {
      // A reporting hook that throws would be caught by the *parent* boundary and
      // read as a second crash. Its failure is a logging problem, not the user's.
      logger.error('onError hook threw', describeError(hostError))
    }
  }

  override componentDidUpdate(previous: ErrorBoundaryProps): void {
    if (this.state.error && keysChanged(previous.resetKeys, this.props.resetKeys)) {
      // Reset retry limits on route changes so one broken screen cannot disable recovery elsewhere.
      this.setState({ error: null, failures: 0 })
    }
  }

  private retry = (): void => {
    this.setState((previous) => ({
      error: null,
      // Change the key on retry so React discards the state that caused the crash.
      resetIndex: previous.resetIndex + 1,
    }))
  }

  override render(): ReactNode {
    const { children, fallback, area, onReturnHome } = this.props
    const { error, failures, resetIndex } = this.state

    if (!error) {
      // The children are NOT wrapped in `FallbackGuard`. The guard is a
      // boundary too, so wrapping them would let it catch their errors first and
      // show the bare minimal screen instead of the real fallback.
      return <Fragment key={resetIndex}>{children}</Fragment>
    }

    const fallbackState: ErrorFallbackState = {
      error,
      failures,
      retry: this.retry,
      returnHome: onReturnHome,
    }

    return (
      <FallbackGuard key={`fallback-${resetIndex}`}>
        {fallback ? (
          <FallbackRenderer render={fallback} state={fallbackState} />
        ) : (
          <DefaultFallback {...fallbackState} area={area} />
        )}
      </FallbackGuard>
    )
  }
}
