/** Read initial native status, then subscribe: server reachability and credentials
 * can change while Settings remains open. Unsubscribe on unmount to avoid duplicate listeners. */

import { useCallback, useEffect, useState } from 'react'

import type { AuthIdentity, ServerStatus } from '../lib/ipc'

import { useConnectionStatus, refreshConnection } from '../connection/connection'
import { bridge, hasBridge } from '../bridge'

/** Keep pending, answered and missing-bridge states distinct so packaged integration failures stay visible. */
export type InstallState<T> =
  | { kind: 'loading' }
  | { kind: 'ready'; value: T }
  | { kind: 'no-bridge' }

export interface ServerStatusView {
  state: InstallState<ServerStatus | null>
  /** Ask main again. Used after a probe, and by the retry button. */
  refresh: () => void
}

export function useServerStatus(): ServerStatusView {
  return { state: useConnectionStatus(), refresh: () => { void refreshConnection() } }
}

export interface AuthIdentityView {
  state: InstallState<AuthIdentity>
  refresh: () => void
}

export function useAuthIdentity(): AuthIdentityView {
  const [state, setState] = useState<InstallState<AuthIdentity>>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!hasBridge()) {
      setState({ kind: 'no-bridge' })
      return
    }
    let alive = true
    const link = bridge()

    link.invoke('auth:get', undefined).then(
      (identity) => {
        if (alive) setState({ kind: 'ready', value: identity })
      },
      () => {
        if (alive) setState({ kind: 'no-bridge' })
      },
    )

    const stop = link.on('auth:changed', (identity) => {
      if (alive) setState({ kind: 'ready', value: identity })
    })

    return () => {
      alive = false
      stop()
    }
  }, [attempt])

  return { state, refresh: useCallback(() => setAttempt((n) => n + 1), []) }
}

/** Prefer the LAN address for pairing because a phone cannot use the desktop's loopback URL.
 * Without one, buildAccessLink explains why pairing is unavailable. */
export function routableAddress(status: ServerStatus | null): string {
  return status?.lanUrl ?? status?.baseUrl ?? ''
}
