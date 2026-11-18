/** The engine running inside this computer's nest, separate from its helper. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { installEngine, useLyricsJobs } from '../../lyrics/lyricsStore'
import { useSettings } from '../context'
import { helperPhase } from '../helper'
import { useToast } from '../parts'

export function useNestEngine() {
  const { t } = useTranslation()
  const { server, surface, admin } = useSettings()
  const engine = useLyricsJobs()?.engine
  const local = surface === 'app' && server.kind === 'ready' && server.value?.mode === 'child'
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const install = async (target: "engine" | "lyrics" | "stems" = "engine") => {
    setBusy(true)
    try { await installEngine(target) }
    catch { toast(t("Could not change it"), { err: true }) }
    finally { setBusy(false) }
  }
  const unavailable = admin !== true ? t("Admins only") : engine && !engine.supported ? t("Not available on this system") : null
  return { local, engine, busy, install, unavailable, phase: engine?.installing?.phase ? helperPhase(engine.installing.phase, t) : t("Installing the engine…") }
}
