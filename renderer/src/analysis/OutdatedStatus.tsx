import { useTranslation } from 'react-i18next'
import './outdated-status.css'

export function OutdatedStatus({ count }: { count: number }) {
  const { t } = useTranslation()
  if (count <= 0) return null
  return <span className="analysis-outdated" role="status" title={t('{{count}} songs analysed by an older engine', { count })}>
    {t('Analysis')} · <span><i aria-hidden="true" />{t('Outdated')}</span>
  </span>
}
