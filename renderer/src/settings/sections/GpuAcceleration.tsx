import { useTranslation } from 'react-i18next'
import { AddonRow, AddonSize } from './AddonCard'
import { Word } from '../parts'
import type { useAddonManagement } from './useAddonManagement'

export function GpuAcceleration({ management }: { management: ReturnType<typeof useAddonManagement> }) {
  const { t } = useTranslation()
  const { status, act, busy, prerequisite, unavailable } = management
  const gpu = status?.addons?.gpu
  const installing = gpu?.installing || ['gpu', 'gpu-remove'].includes(status?.installing?.target ?? '')
  const included = gpu?.included === true || (management.computer?.isMac === true && status?.supported === true)
  const ready = gpu?.ready === true
  const reason = gpu?.reason ? t(gpu.reason) : unavailable
  return <AddonRow label={t("GPU acceleration")}
    size={included ? undefined : gpu?.available || gpu?.installed ? <AddonSize bytes={gpu.sizeBytes} installed={gpu.installed} estimate={gpu.downloadBytes ?? 3_200_000_000} details="CUDA 13 · torch" /> : undefined}
    value={included ? 'MLX' : gpu?.card ?? t('CPU')} mono
    state={<Word tone={gpu?.error ? 'bad' : installing ? 'warn' : included || ready ? 'ok' : 'off'} title={gpu?.error || reason || undefined}>
      {gpu?.error ? t("Could not change it") : included ? t("Included") : installing ? t("Installing") : ready ? t("Installed_feminine") : gpu?.available ? t("Not installed") : t("Unavailable")}
    </Word>}
    actions={!included && (gpu?.available || gpu?.installed) ? <button type="button" className="ks-btn"
      disabled={busy || !!status?.installing || !!prerequisite || !!unavailable}
      title={prerequisite || unavailable || undefined} onClick={() => void act('gpu', gpu.installed)}>
      {gpu.installed ? t("Remove") : t("Install")}
    </button> : null} />
}
