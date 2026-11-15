/** This desktop's predicted hardware, superseded by its measured helper facts. */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { refreshMac, useMacEngine } from '../../lyrics/macEngine'
import { useLyricsJobs, watchJobs } from '../../lyrics/lyricsStore'
import { msg } from '../../i18n'
import { bridge, hasBridge } from '../../bridge'
import { useSettings } from '../context'
import { HELPER_STATES, helperHardware, helperPhase, helperSpeed } from '../helper'
import { useToast } from '../parts'
import { installFailure } from '../engine'

const ERRORS: Record<string, string> = {
  'token-rejected': msg("Access denied"),
  'network-denied': msg("Local Network permission denied"),
  replaced: msg("Another helper is already processing for the nest"),
  'nest-unreachable': msg("Offline"),
  'not-owner': msg("Only an admin account can process for the nest"),
}
const PHASES: Record<string, string> = {
  entorno: msg("Preparing the engine…"), paquetes: msg("Installing the engine…"),
  modelos: msg("Downloading models…"), updating: msg("Updating the engine…"),
}

/** Hardware and connection facts for this desktop's shared helper. */
export function useComputerProcessing() {
  const { t, i18n } = useTranslation()
  const { surface, me, admin } = useSettings()
  const engine = useMacEngine()
  const jobs = useLyricsJobs()
  const status = engine.status
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (surface !== 'app' || !hasBridge()) return
    void refreshMac()
    const offJobs = admin ? watchJobs() : () => {}
    const offProgress = bridge().on('lyrics:engine-progress', () => { void refreshMac() })
    const offWorker = bridge().on('lyrics:worker-changed', () => { void refreshMac() })
    return () => { offJobs(); offProgress(); offWorker() }
  }, [surface, admin])
  const act = async (action: () => Promise<void>) => {
    setBusy(true)
    try { await action() } catch (error) { toast(t(ERRORS[String(error instanceof Error ? error.message : error)] ?? "Could not change it"), { err: true }) }
    finally { setBusy(false) }
  }
  if (surface !== 'app' || !status) return null
  // A nest can have several helpers; the compatibility `worker` may be another computer.
  const own = jobs?.engine?.helpers?.find(h => h.id === status.workerId)
  const worker = own ?? (status.worker?.id === status.workerId ? status.worker : null)
  const platform = worker?.os ?? (/Mac/i.test(navigator.platform) ? 'macos' : /Win/i.test(navigator.platform) ? 'windows' : 'linux')
  const isMac = platform === 'macos'
  const facts = worker ?? status.hardware
  const accel = facts?.accel
  const memory = facts?.memoryBytes
  const tooSmall = memory != null && memory < 8 * 2 ** 30
  // A worker advertises only ready add-ons. Empty installed jobs do not mean
  // this hardware cannot install its first add-on.
  const noJobs = status.hardware?.jobs != null && status.hardware.jobs.length === 0
  const cannot = tooSmall || noJobs || !status.supported
  const reason = tooSmall ? t("Needs 8 GB of memory · this computer has {{n}} GB", { n: Number((memory / 2 ** 30).toFixed(1)).toLocaleString(i18n.language) }) : noJobs ? t("This computer cannot do any of these jobs") : !status.supported ? t("Not available on this system") : null
  const permission = me?.role !== 'owner' || me.source !== 'token' ? t("Only an admin account can process for the nest") : null
  const disabledReason = permission || reason || (!status.eligible ? t("This computer already hosts the nest") : null)
  const issue = status.workerError || status.local?.lastError || engine.lastError || status.installError
  const issueWord = issue ? t(ERRORS[issue] ?? (issue === status.installError ? installFailure(issue, 'engine') : "Could not change it")) : null
  const connected = status.agentRunning && status.local?.connected
  const working = connected && worker?.state === 'working'
  const word = worker?.state === 'outdated' ? HELPER_STATES.outdated : working ? HELPER_STATES.working : HELPER_STATES.idle
  const hardware = facts ? helperHardware({ ...facts, os: platform, macos: worker?.macos }) : ''
  const speed = helperSpeed(worker, 'align')
  const statusTip = [status.agentRunning ? t("Running") : null, status.enabled ? t(connected ? "Connected to the nest" : "Offline") : null, status.enabled && connected ? t(word.word) : null, disabledReason, issue ? t(ERRORS[issue] ?? issue) : null,
    working && worker?.job ? `${worker.job.title}${worker.job.phase ? ` · ${helperPhase(worker.job.phase, t)}` : ''}` : null,
    worker?.state === 'outdated' ? t("Update Flipspin on that computer to update the engine.") : null].filter(Boolean).join(' · ')
  const state = status.installing ? `${t(PHASES[status.installing.phase ?? ''] ?? "Installing the engine…")}${status.installing.percent != null ? ` · ${status.installing.percent}%` : ''}`
    : issue ? issueWord : disabledReason || (status.enabled ? `${t(connected ? "Connected to the nest" : "Offline")}${connected ? ` · ${t(word.word)}` : ''}` : t("Off"))
  const tone = issue || (status.enabled && !connected && !status.installing && !disabledReason) ? 'bad' : disabledReason || status.installing ? 'warn' : status.enabled && connected ? word.tone : 'off'
  return { status, busy, act, worker, facts, accel, cannot, isMac, hardware, speed, disabledReason, reason, issue, connected, working, word, statusTip, state, tone, phase: status.installing ? t(PHASES[status.installing.phase ?? ''] ?? "Installing the engine…") : null }
}
