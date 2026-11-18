import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { traceStore } from './trace'

export default function TraceOverlay() {
  const [visible, setVisible] = useState(false)
  const stats = useSyncExternalStore(traceStore.subscribe, traceStore.getSnapshot)
  const { t } = useTranslation()
  useEffect(() => {
    const toggle = (event: KeyboardEvent) => {
      if (event.altKey && event.metaKey && event.code === 'KeyP') { event.preventDefault(); setVisible(value => !value) }
    }
    window.addEventListener('keydown', toggle)
    return () => window.removeEventListener('keydown', toggle)
  }, [])
  if (!visible) return null
  return <output className="fixed top-20 right-4 bg-panel border-2 border-black rounded-xl p-3 font-mono text-xs" aria-label={t("Playback diagnostics")}>
    <dl>
      <dt>{t("Home")}</dt><dd>{Math.round(stats.startup)}{' '}{t("ms")}</dd>
      <dt>{t("Rebuffers")}</dt><dd>{stats.rebufferCount} · {Math.round(stats.rebufferMs)}{' '}{t("ms")}</dd>
      <dt>{t("Seek")}</dt><dd>{Math.round(stats.seekMs)}{' '}{t("ms")}</dd>
      <dt>{t("Last error")}</dt><dd>{stats.lastError || t("No data")}</dd>
      <dt>{t("Gain")}</dt><dd>{stats.gain.toFixed(3)}</dd>
      <dt>{t("Cache")}</dt><dd>{stats.cacheHit === null ? t("No data") : stats.cacheHit ? t("Yes") : t('No')}</dd>
    </dl>
  </output>
}
