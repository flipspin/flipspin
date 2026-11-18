/** Select a server before authentication and mount the app only after identity is resolved.
 * If an older server has no handshake, assume it has accounts and offer sign-in
 * rather than a claim action that could fail with a conflict. */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { ServerStatus } from '../lib/ipc'

import { DataProvider, useServerHandshake } from '../data'
import { UiProvider } from '../ui'
import { AuthGate } from '../auth/AuthGate'
import { bridge, hasBridge } from '../bridge'
import { useConnection } from '../connection/connection'
import { FirstLaunchScreen } from '../connection/FirstLaunchScreen'
import { useServerStatus } from '../settings/useInstall'
import { SERVER_PROBLEM } from '../settings/messages'
import { Onboarding } from '../onboarding'
import { NestStep } from '../onboarding/NestStep'
import { SetupSurface } from '../setup/SetupSurface'
import { APP_NAME } from '../brand'
import { Button } from '../ui/react/components/Button'

interface GateProps {
  children: React.ReactNode
}

function Authenticated({ children, localNest, useOffline = false, waitingScreen }: GateProps & { localNest: boolean; useOffline?: boolean; waitingScreen?: React.ReactNode }): React.JSX.Element {
  const connection = useConnection()
  const handshake = useServerHandshake()
  const [manualOffline, setManualOffline] = useState(false)
  const [changing, setChanging] = useState(false)
  const [startedAt] = useState(Date.now)
  const fallback = useOffline || manualOffline || handshake.isError || connection.state === 'unreachable'
  const [entered, setEntered] = useState(false)
  const [openedWithoutSession, setOpenedWithoutSession] = useState(false)
  useEffect(() => {
    if (fallback) setOpenedWithoutSession(true)
    if (!handshake.isPending || fallback || connection.state === 'needs-auth') setEntered(true)
  }, [fallback, handshake.isPending, connection.state])

  if (changing) return <NestStep mode={localNest ? 'child' : 'external'} join onBack={() => setChanging(false)} />

  if (!entered && !fallback && handshake.isPending && connection.state !== 'needs-auth') {
    return <>{waitingScreen ?? <FirstLaunchScreen connection={connection} startedAt={startedAt} onChangeNest={() => setChanging(true)} onUseOffline={() => setManualOffline(true)} />}</>
  }

  // Once admitted (including after an unreachable launch), keep this gate
  // and the app mounted while the handshake and session catch up on return.
  return (
    <AuthGate
      allowUnknownSession={openedWithoutSession || fallback}
      waitingScreen={waitingScreen}
      sessionCheckEnabled={!handshake.isPending}
      serverIsInit={handshake.data?.isInit ?? true}
      setupTokenRequired={handshake.data?.setupTokenRequired}
      dataDir={handshake.data?.dataDir}
      serverLabel={handshake.data?.name ?? null}
      localNest={localNest}
      setupDone={handshake.data?.setupDone}
      nestName={handshake.data?.name}
    >
      {children}
    </AuthGate>
  )
}

/** What the shell's status says this gate should draw. */
type NestDecision = 'asking' | 'choose' | 'starting' | 'problem' | 'app'

function decide(status: ServerStatus | null, loading: boolean): NestDecision {
  if (loading) return 'asking'
  if (status === null) return 'app'
  if (status.connection.state === 'unchosen' || status.connection.state === 'wrong-nest') return 'choose'
  if (status.mode === 'child' && status.problem !== null) return 'problem'
  // Wait for remote startup probes within REMOTE_GATE so handshake retries do not open an unconnected app prematurely.
  if (status.connection.state === 'connecting') return 'starting'
  return 'app'
}

/** The first-run wizard from its welcome: "Nest" relaunches the app into the chosen nest. */
function FirstRun({ mode }: { mode: ServerStatus['mode'] }): React.JSX.Element {
  return <Onboarding entry="welcome" mode={mode} onFinished={() => undefined} />
}

/** Wait for an explicitly starting local server until it answers or reports a problem.
 * Only initial selection blocks: later outages must preserve the mounted player and app state. */
function NestGate({ children }: GateProps): React.JSX.Element {
  const { t } = useTranslation()
  const server = useServerStatus()
  const [through, setThrough] = useState(false)
  const [changing, setChanging] = useState(false)
  const [useOffline, setUseOffline] = useState(false)
  const [startedAt] = useState(Date.now)
  const connection = useConnection()
  const status = server.state.kind === 'ready' ? server.state.value : null
  const copyKey = connection.state === 'connecting' && status ? `${status.baseUrl}:${status.instanceId}` : null
  const [copy, setCopy] = useState<{ key: string; present: boolean } | null>(null)
  useEffect(() => {
    if (!copyKey) return
    let alive = true
    void bridge().invoke('offline:snapshot', { kind: 'listing' }).then(row => {
      if (alive) setCopy({ key: copyKey, present: Boolean(row) })
    }).catch(() => { if (alive) setCopy({ key: copyKey, present: false }) })
    return () => { alive = false }
  }, [copyKey])
  const savedCopy = copyKey !== null && copy?.key === copyKey && copy.present
  const decision =
    server.state.kind === 'no-bridge' ? 'app' : decide(status, server.state.kind === 'loading')

  useEffect(() => {
    if (decision === 'app' || savedCopy) setThrough(true)
  }, [decision, savedCopy])

  const waitingScreen = <FirstLaunchScreen
    connection={connection}
    nestName={status?.name}
    address={status?.via ?? status?.baseUrl}
    startedAt={startedAt}
    onChangeNest={() => setChanging(true)}
    onUseOffline={() => { setUseOffline(true); setThrough(true) }}
  />

  if (changing) return <NestStep mode={status?.mode ?? null} join onBack={() => setChanging(false)} />

  if (decision === 'choose' && status?.connection.state === 'wrong-nest') return <NestStep mode={status?.mode ?? null} join onBack={() => setChanging(false)} />

  if (through || decision === 'app' || savedCopy) {
    return <Authenticated localNest={status?.mode === 'child'} useOffline={useOffline || savedCopy} waitingScreen={waitingScreen}>{children}</Authenticated>
  }

  if (decision === 'choose') return <FirstRun mode={status?.mode ?? null} />

  if (decision === 'problem' && status?.problem) {
    return (
      <SetupSurface labelledBy="nest-problem-heading">
        <h1 id="nest-problem-heading" className="krobi-setup__title">
          {t("Your nest didn't start")}
        </h1>
        <div role="alert" className="z-banner" data-tone="danger">
          {t(SERVER_PROBLEM[status.problem], { app: APP_NAME })}
        </div>
        <div className="krobi-setup__actions">
          <Button variant="primary" onClick={server.refresh}>
            {t("Retry")}
          </Button>
          <Button onClick={() => setChanging(true)}>{t("Change nest")}</Button>
        </div>
      </SetupSurface>
    )
  }

  // Wait only for the local read before deciding whether a first-launch screen is needed.
  if (server.state.kind === 'loading' || (copyKey && copy?.key !== copyKey)) return null
  return waitingScreen
}

export default function Gate({ children }: GateProps): React.JSX.Element {
  return (
    <UiProvider>
      <DataProvider>
        {hasBridge() ? <NestGate>{children}</NestGate> : import.meta.env.DEV ? children : <Authenticated localNest={false}>{children}</Authenticated>}
      </DataProvider>
    </UiProvider>
  )
}
