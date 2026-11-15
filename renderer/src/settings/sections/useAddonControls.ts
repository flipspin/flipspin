import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { refreshMac } from '../../lyrics/macEngine'
import { bridge } from '../../bridge'
import { useSettings } from '../context'
import { useCompute, useComputeActions } from '../background/data'
import { useAddonManagement, type InstallTarget } from './useAddonManagement'

/** Local installation and helper policy share the machine's reported identity. */
export function useAddonControls() {
  const management = useAddonManagement()
  const { admin, surface, me } = useSettings()
  const { t } = useTranslation()
  const compute = useCompute(admin === true)
  const actions = useComputeActions()
  const { status, nest, computer } = management
  const workerId = status && 'workerId' in status ? status.workerId : null
  const own = compute.data?.computers.find(computer => nest.local ? computer.nest : computer.id === workerId)
  // Analysis has no shared-engine memory requirement. Gate it separately.
  const unavailable = admin !== true ? t("Admins only") : !nest.local && surface !== 'app' ? t("Start it from the desktop app on the computer.") : status?.supported === false ? t("Not available on this system") : !nest.local && status && 'eligible' in status && !status.eligible ? t("This computer already hosts the nest") : !nest.local && (me?.role !== 'owner' || me?.source !== 'token') ? t("Only an admin account can process for the nest") : null
  const memory = own?.memoryBytes ?? computer?.facts?.memoryBytes
  const [consent, setConsent] = useState(false)
  const [acknowledged, setAcknowledged] = useState(false)
  const [batch, setBatch] = useState<InstallTarget[]>([])
  const [requested, setRequested] = useState<InstallTarget | null>(null)
  const [all, setAll] = useState(false)
  const busy = management.busy || actions.busy || !!status?.installing || batch.length > 0

  // One request per target. Wait for reported readiness before the next install.
  useEffect(() => {
    const target = batch[0]
    if (!target || !status) return
    const addon = target === 'engine' || target === 'gpu' ? null : status.addons?.[target]
    const ready = target === 'engine' ? management.engineReady : addon?.ready
    if (ready) { setBatch(current => current.slice(1)); setRequested(null); return }
    if (requested === target) {
      if (addon?.error || status.installError) { setBatch([]); setRequested(null) }
      return
    }
    if (management.busy || status.installing) return
    setRequested(target)
    void management.act(target).then(ok => { if (!ok) { setBatch([]); setRequested(null) } })
  }, [batch, requested, status, management])

  async function act(target: InstallTarget, remove = false) {
    if (target === 'lyrics' && !remove) { setAcknowledged(false); setConsent(true); return false }
    return management.act(target, remove)
  }
  async function installAll(value: boolean) {
    if (own && !await actions.computer(own, { installEverything: value })) return
    setAll(value)
    if (value) setBatch(memory != null && memory < 8 * 2 ** 30 ? ['analysis'] : ['engine', 'analysis', 'stems'])
    else { setBatch([]); setRequested(null) }
  }
  async function help(enabled: boolean) {
    await actions.act(async () => {
      const result = await bridge().invoke('lyrics:worker-set', { enabled })
      if (!result.ok) throw new Error(result.reason)
      await refreshMac()
    })
  }
  function use(kind: 'align' | 'analysis' | 'stems', enabled: boolean) {
    if (own) void actions.computer(own, { use: { ...own.limits.use, [kind]: enabled, ...(kind === 'align' ? { transcribe: enabled } : {}) } })
  }
  return { ...management, compute, unavailable, busy, act, own, memory, use, help, installAll,
    everything: own?.limits.installEverything ?? all,
    consent, setConsent, acknowledged, setAcknowledged,
    confirmLyrics: () => { setConsent(false); void management.act('lyrics') },
  }
}
