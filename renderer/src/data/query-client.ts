/**
 * The cache and its defaults.
 *
 * Every option below is set explicitly, including two that happen to match the
 * library's own default, because the defaults are tuned for a web page that is
 * opened, used and closed. This is a desktop app that sits open for days beside
 * a backend the same user is mutating from the same window, sometimes over a
 * home VPN. Several of the defaults are wrong for that, one of them severely.
 */

import { QueryClient } from '@tanstack/react-query'

import { isApiError } from './errors'

/** Extra attempts after the first, for failures that could plausibly succeed later. */
const MAX_RETRIES = 2

/** Retry requests that receive no answer, allowing startup and wake-time network recovery.
 * A 4xx is a refusal; repeating it adds latency without changing the result. */
export function shouldRetryRequest(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false

  if (isApiError(error)) {
    // A malformed response is a client/server mismatch; requesting it again cannot repair it.
    if (error.kind === 'malformed') return false
    // No preload bridge means the page is not running inside the shell at all.
    // Nothing about that changes by waiting.
    if (error.kind === 'bridge') return false
    if (error.status !== null && error.status >= 400 && error.status < 500) return false
  }

  return true
}

/** Keep startup backoff short so an unreachable backend reaches an actionable error state promptly. */
export function retryDelayFor(attemptIndex: number): number {
  return Math.min(400 * 2 ** attemptIndex, 2_000)
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryRequest,
        retryDelay: retryDelayFor,

        // The connection adapter drives onlineManager from the shell, never navigator.onLine.
        networkMode: 'online',

        /** The change handler catches up dirty areas on return to focus.
         * A second TanStack focus refetch would duplicate that work. */
        refetchOnWindowFocus: false,

        /** Hello revisions own reconnect resync; dirty areas catch up on focus. */
        refetchOnReconnect: false,

        /**
         * On. Combined with `staleTime` below this means "refetch when a screen
         * is opened and its data is older than half a minute", which is the
         * behaviour a user expects from navigating somewhere.
         */
        refetchOnMount: true,

        /** Cache across brief navigation, but expire soon enough to pick up other household clients' changes. */
        staleTime: 30_000,

        /**
         * How long an unused cache entry survives. Raised from five minutes
         * because a desktop app is left alone for hours; at the default, coming
         * back to the window after lunch means every screen is a spinner even
         * though nothing changed.
         */
        gcTime: 30 * 60_000,
      },

      mutations: {
        /** Do not retry writes automatically: an ambiguous failure may already have applied a non-idempotent change. */
        retry: false,
        networkMode: 'always',
      },
    },
  })
}
