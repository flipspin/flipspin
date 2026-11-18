import { useTranslation } from 'react-i18next'
import './offline.css'

export function SnapshotAge({ at }: { at: number | null }) {
  const { t, i18n } = useTranslation()
  if (at === null) return null
  const time = new Date(at * 1000).toLocaleTimeString(i18n.language, { hour: '2-digit', minute: '2-digit', hour12: false })
  return <span className="ak-copy-age" title={t("A copy of your library saved on this computer")}>{t("copy from {{time}}", { time })}</span>
}
