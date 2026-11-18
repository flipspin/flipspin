import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import type { ServerMode } from '../lib/ipc'

import { apiGet, apiPost, queryKeys, type HandshakeData } from '../data'
import { useServerStatus, routableAddress } from '../settings/useInstall'
import { AccountStep } from './AccountStep'
import { DevicesStep } from './DevicesStep'
import { DoneStep } from './DoneStep'
import { MusicStep, type LibrarySummary } from './MusicStep'
import { WizardPlan, STEPS, type StepId } from './plan'
import { useNestAddresses } from '../remote/useNestAddresses'
import { NestStep } from './NestStep'
import { RemoteStep } from './RemoteStep'
import { AddonsStep, type AddonId } from './AddonsStep'
import { SourcesStep } from './SourcesStep'
import './steps.css'

export type OnboardingEntry = 'welcome' | 'account' | 'resume' | 'member'
type Step = StepId

export interface OnboardingProps {
  entry: OnboardingEntry
  /** Shell mode keeps "On this computer" accurate for an existing local nest. */
  mode?: ServerMode | null
  /** The initial nest name comes from the server handshake. */
  nestName?: string
  setupTokenRequired?: boolean
  /** This computer hosts the nest (the music folder can be changed here). */
  localNest?: boolean
  onFinished: () => void
}

export function Onboarding({
  entry,
  mode = null,
  nestName,
  setupTokenRequired,
  localNest = false,
  onFinished,
}: OnboardingProps): React.JSX.Element {
  const { t } = useTranslation()
  const server = useServerStatus()
  const status = server.state.kind === 'ready' ? server.state.value : null
  const serverUrl = routableAddress(status)
  const member = entry === 'member'
  const [finishing, setFinishing] = useState(false)
  const [finishError, setFinishError] = useState<string | null>(null)
  const plan = member ? ['devices' as const] : STEPS.map(s => s.id)

  const [step, setStep] = useState<Step>(entry === 'welcome' ? 'nest' : entry === 'account' ? 'account' : member ? 'devices' : 'music')
  const queryClient = useQueryClient()
  const network = useNestAddresses(undefined, !['nest', 'account'].includes(step))
  const pairingUrl = network.network?.lan[0] ?? routableAddress(status)
  const [username, setUsername] = useState('')
  const reportedName = nestName || status?.name || 'Nido'
  const [name, setName] = useState(reportedName)
  const [nameEdited, setNameEdited] = useState(false)
  const [summary, setSummary] = useState<LibrarySummary | null>(null)
  const [devices, setDevices] = useState(0)
  const [albums, setAlbums] = useState<string[]>([])
  const [analyseHere, setAnalyseHere] = useState(false)
  const [addons, setAddons] = useState<AddonId[]>([])
  const [sources, setSources] = useState<boolean | null>(null)
  const [remote, setRemote] = useState<'tailscale' | 'local' | null>(null)
  const [editing, setEditing] = useState(false)
  const [claimed, setClaimed] = useState(entry === 'resume')
  const change = (target: StepId) => { setEditing(true); setStep(target) }
  const advance = (target: StepId) => { setStep(editing ? 'done' : target); setEditing(false) }

  useEffect(() => {
    if (!nameEdited) setName(reportedName)
  }, [reportedName, nameEdited])

  // Resumed setup loads the signed-in identity when the account step is already complete.
  useEffect(() => {
    if (username || step === 'nest' || step === 'account') return
    let alive = true
    void apiGet('/api/me')
      .then((me) => {
        const found = me.username ?? me.label
        if (alive && found) setUsername(found)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [step, username])

  const host = serverUrl ? (
    <span className="kob-host" title={serverUrl}>
      <span className="kob-dot is-ok" />
      {name}
    </span>
  ) : null

  function renderStep() {
    switch (step) {
      case 'nest':
        return <NestStep mode={mode} join={false} onBack={editing ? () => { setStep('done'); setEditing(false) } : undefined} />
      case 'account':
        return (
          <AccountStep
            setupTokenRequired={setupTokenRequired}
            existingUsername={claimed ? username : undefined}
            nestName={name}
            host={host}
            localNest={localNest}
            onCreated={(created) => {
              setUsername(created)
              setClaimed(true)
              advance('music')
            }}
          />
        )
      case 'music':
        return (
          <MusicStep
            localNest={localNest}
            host={host}
            analyseHere={analyseHere}
            onAnalyseHere={setAnalyseHere}
            onDone={(found, titles) => {
              setSummary(found)
              setAlbums(titles)
              advance('sources')
            }}
          />
        )
      case 'sources':
        return <SourcesStep host={host} initialPicked={sources ?? true} onBack={() => setStep(editing ? 'done' : 'music')} onDone={picked => { setSources(picked); advance('remote') }} />
      case 'devices':
        return (
          <DevicesStep
            serverUrl={pairingUrl}
            initialCount={devices}
            finishing={finishing}
            finishError={finishError}
            username={username}
            host={host}
            onBack={undefined}
            onDone={(paired) => {
              setDevices(paired)
              if (member) {
                setFinishing(true)
                setFinishError(null)
                void apiPost('/api/me/onboarded').then(() => onFinished()).catch(() => {
                  setFinishError(t("Could not save. Try again to continue."))
                }).finally(() => setFinishing(false))
              } else advance('remote')
            }}
          />
        )
      case 'remote':
        return (
          <RemoteStep
            nestName={name}
            host={host}
            onBack={() => setStep(editing ? 'done' : 'sources')}
            onDone={(outcome) => {
              setRemote(outcome)
              try { localStorage.setItem(`krobi.setup-remote.${queryClient.getQueryData<HandshakeData>(queryKeys.server.handshake())?.instanceId ?? serverUrl}`, outcome) } catch { /* Storage failure keeps the route choice in this session. */ }
              advance('addons')
            }}
          />
        )
      case 'addons':
        return <AddonsStep initialPicked={analyseHere ? ['analysis'] : []} host={host} onBack={() => setStep(editing ? 'done' : 'remote')} onDone={picked => { setAddons(picked); advance('done') }} />
      case 'done':
        return (
          <DoneStep
            nestName={name}
            onNameChange={chosen => { setName(chosen); setNameEdited(true) }}
            onChange={change}
            username={username}
            songs={summary ? summary.songs : null}
            albums={albums}
            addons={addons}
            serverUrl={serverUrl}
            remote={remote}
            host={host}
            onBack={() => setStep('addons')}
            onFinished={onFinished}
          />
        )
    }

  }
  return <WizardPlan value={plan}>{renderStep()}</WizardPlan>
}
