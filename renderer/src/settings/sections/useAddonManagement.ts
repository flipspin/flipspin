import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { refreshMac } from '../../lyrics/macEngine'
import { bridge } from '../../bridge'
import { useSettings } from '../context'
import { useToast } from '../parts'
import { useComputerProcessing } from './useComputerProcessing'

export type InstallTarget = 'engine' | 'lyrics' | 'stems' | 'analysis' | 'gpu'

export function useAddonManagement() {
  const { t } = useTranslation()
  const { surface } = useSettings()
  const computer = useComputerProcessing()
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const status = computer?.status
  const unavailable = computer?.disabledReason || (surface !== 'app' ? t("Start it from the desktop app on the computer.") : null)
  const installing = status?.installing
  const engineInstalling = !!installing && (!installing.target || installing.target === 'engine')
  const engineReady = !!status?.installed && (status.engineReady ?? status.hint === 'ready')
  const prerequisite = engineInstalling ? t("Installing the engine…") : !engineReady ? t("Install the engine first") : null
  const act = async (target: InstallTarget, remove = false) => {
    setBusy(true)
    try {
      const result = remove
        ? await bridge().invoke('lyrics:engine-remove', { target })
        : await bridge().invoke('lyrics:engine-install', { target })
      if ('started' in result && !result.started) throw new Error(result.reason)
      await refreshMac()
      return true
    } catch { toast(t("Could not change it"), { err: true }); return false }
    finally { setBusy(false) }
  }
  return { computer, status, unavailable, busy, act, engineReady, engineInstalling, prerequisite }
}
