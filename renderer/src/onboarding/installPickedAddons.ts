import { waitForPoll } from '../data/poll'
import { setMacWorker } from '../lyrics/macEngine'
import { bridge } from '../bridge'
import type { AddonId } from './AddonsStep'

/** Lyrics and Stems share engine provisioning through the shell worker switch. */
export async function installPickedAddons(picked: AddonId[]): Promise<void> {
  const sharedEngine = picked.some(id => id !== 'analysis')
  if (sharedEngine) await setMacWorker(true)
  if (!picked.includes('analysis')) return

  // The shell acknowledges an occupied installer without queuing the target.
  // Analysis waits for the engine download so its target is not lost.
  let status = await bridge().invoke('lyrics:engine-status', undefined)
  const waiting = !!status.installing
  while (status.installing) {
    await waitForPoll(1000)
    status = await bridge().invoke('lyrics:engine-status', undefined)
  }
  if (waiting && status.installError) throw new Error(status.installError)
  const result = await bridge().invoke('lyrics:engine-install', { target: 'analysis' })
  if (!result.started || result.already) throw new Error(result.reason ?? 'install-not-started')

  // Analysis installation starts before the worker is enabled; an empty helper
  // otherwise provisions the full engine instead of only the selected add-on.
  if (!sharedEngine) await setMacWorker(true)
}
