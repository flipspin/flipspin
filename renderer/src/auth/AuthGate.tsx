/** Validate the credential with the server: a stored token may be revoked.
 * A refusal requires sign-in; a network failure requires reconnection. */
import { useCallback, useEffect, useRef, useState } from 'react'

import { apiGet, apiPost, isApiError, type CurrentUser } from '../data'
import { logger } from '../ui'
import { bridge } from '../bridge'
import { useConnection, connectionStore } from '../connection/connection'
import { SignIn } from './SignIn'
import { SignInRequestsProvider } from './SignInRequestsProvider'
import { Onboarding } from '../onboarding'
import { isPhoneLabel } from '../pairing/deviceKind'
import { rememberNestNetwork } from '../remote/network'
import { FirstLaunchScreen } from '../connection/FirstLaunchScreen'
import { NestStep } from '../onboarding/NestStep'

export interface AuthGateProps {
  /** From the handshake: false when this server has no accounts at all. */
  serverIsInit: boolean
  /** The app already opened while the shell was unreachable. */
  allowUnknownSession?: boolean
  sessionCheckEnabled?: boolean
  waitingScreen?: React.ReactNode
  serverLabel?: string | null
  setupTokenRequired?: boolean
  dataDir?: string
  /**
   * This computer hosts the nest (`ServerStatus.mode === 'child'`): the wizard's
   * music step may change its folder.
   */
  localNest?: boolean
  /** From the handshake: false while the first-run wizard is unfinished. */
  setupDone?: boolean
  nestName?: string
  children: React.ReactNode
}

type Phase =
  | { kind: 'checking' }
  | { kind: 'signed-in' }
  | { kind: 'needs-account' }
  | { kind: 'needs-sign-in' }
  /** An owner on a nest whose first-run wizard was never finished. */
  | { kind: 'resume-setup' }
  | { kind: 'member-devices' }

export function AuthGate({
  serverIsInit,
  allowUnknownSession = false,
  sessionCheckEnabled = true,
  waitingScreen,
  serverLabel,
  setupTokenRequired,
  dataDir: _dataDir,
  localNest = false,
  setupDone,
  nestName,
  children,
}: AuthGateProps): React.JSX.Element {
  const connection = useConnection()
  const [startedAt] = useState(Date.now)
  const [useOffline, setUseOffline] = useState(false)
  const [changing, setChanging] = useState(false)
  const checked = useRef(false)
  const checkId = useRef(0)
  const [me, setMe] = useState<CurrentUser | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' })

  // Read the handshake through a ref so claim invalidation cannot reset the active first-run screen.
  const serverIsInitRef = useRef(serverIsInit)
  useEffect(() => {
    serverIsInitRef.current = serverIsInit
  }, [serverIsInit])
  // Keep wizard completion sticky while the refreshed handshake catches up.
  const setupDoneRef = useRef(setupDone)
  const finishedRef = useRef(false)
  useEffect(() => {
    setupDoneRef.current = setupDone
  }, [setupDone])

  const check = useCallback(async () => {
    const status = connectionStore.getSnapshot()
    if (status.kind !== 'no-bridge' && (status.kind !== 'ready' || status.value?.connection.state !== 'connected')) return
    const id = ++checkId.current
    if (!checked.current) setPhase({ kind: 'checking' })
    let hasToken = false
    try {
      hasToken = Boolean((await bridge().invoke('auth:get', undefined))?.hasToken)
    } catch (error) {
      logger.error('Could not read the stored credential', { error: String(error) })
    }

    if (id !== checkId.current) return
    if (!hasToken) {
      setPhase(serverIsInitRef.current ? { kind: 'needs-sign-in' } : { kind: 'needs-account' })
      return
    }


    try {
      const me = await apiGet('/api/me')
      if (id !== checkId.current) return
      checked.current = true
      setMe(me)
      void rememberNestNetwork()
      const unfinished = setupDoneRef.current === false && !finishedRef.current
      if (!me.isOwner && me.source === 'token' && me.onboarded === false) {
        const { devices } = await apiGet('/api/me/devices')
        if (!devices.some(d => !d.isCurrent && d.lastSeenAt && isPhoneLabel(d.label))) {
          setPhase({ kind: 'member-devices' })
          return
        }
        await apiPost('/api/me/onboarded')
      }
      if (id !== checkId.current) return
      setPhase(unfinished && me?.isOwner && me?.source === 'token' ? { kind: 'resume-setup' } : { kind: 'signed-in' })
    } catch (error) {
      if (id !== checkId.current) return
      if (isApiError(error) && (error.status === 401 || error.status === 403)) {
        // Only an authentication refusal is reported to the shell.
        void bridge().invoke('server:report-auth', { status: error.status as 401 | 403 }).catch(() => {})
        setPhase({ kind: 'needs-sign-in' })
        return
      }
      if (isApiError(error) && error.status === 404) {
        checked.current = true
        // An unsupported identity route does not invalidate an otherwise usable credential.
        setPhase({ kind: 'signed-in' })
        return
      }
      // The proxy reports transport failures to the shell. Wait for its next
      // connected event; a network error never signs a person out.
    }
  }, [])

  useEffect(() => {
    if (connection.state === 'connected' && sessionCheckEnabled) void check()
    const counter = checkId
    return () => { counter.current++ }
  }, [check, connection.state, sessionCheckEnabled])

  const shownPhase = connection.state === 'needs-auth' ? 'needs-sign-in' : phase.kind
  if (changing) return <NestStep mode={localNest ? 'child' : 'external'} join onBack={() => setChanging(false)} />
  switch (shownPhase) {
    case 'checking':
      if (allowUnknownSession || useOffline) return <SignInRequestsProvider me={me}>{children}</SignInRequestsProvider>
      return <>{waitingScreen ?? <FirstLaunchScreen
        connection={connection}
        nestName={nestName ?? serverLabel}
        startedAt={startedAt}
        onChangeNest={() => setChanging(true)}
        onUseOffline={() => setUseOffline(true)}
      />}</>

    case 'needs-account':
    case 'resume-setup':
      return (
        <SignInRequestsProvider me={me}><Onboarding
          entry={phase.kind === 'resume-setup' ? 'resume' : 'account'}
          nestName={nestName}
          setupTokenRequired={setupTokenRequired}
          localNest={localNest}
          onFinished={() => {
            finishedRef.current = true
            void check()
          }}
        /></SignInRequestsProvider>
      )

    case 'member-devices':
      return <SignInRequestsProvider me={me}><Onboarding entry="member" nestName={nestName} onFinished={() => {
        setPhase({ kind: 'signed-in' })
      }} /></SignInRequestsProvider>

    case 'needs-sign-in':
      return (
        <SignIn
          serverLabel={nestName ?? serverLabel}
          // Only offered when the server genuinely has nobody on it. Showing it
          // otherwise invites somebody to try to claim a server that is already
          // claimed, and get a 409 they cannot act on.
          onCreateInstead={serverIsInit ? undefined : () => setPhase({ kind: 'needs-account' })}
          onSignedIn={() => void check()}
        />
      )

    case 'signed-in':
      return <SignInRequestsProvider me={me}>{children}</SignInRequestsProvider>
  }
}
