import { useTranslation } from 'react-i18next'
import type { ServerMode } from '../lib/ipc'
import { ModalLayer } from '../ui/react/components/ModalLayer'
import { NestStep } from './NestStep'

/** Settings and connection details reuse the same nest-selection step. */
export function ChangeNestDialog({ mode, onClose }: { mode: ServerMode | null; onClose: () => void }) {
  const { t } = useTranslation()
  return <ModalLayer className="kob-change-nest" aria-label={t("Change nest")} onClose={onClose}>
    <NestStep mode={mode} join onBack={onClose} />
  </ModalLayer>
}
