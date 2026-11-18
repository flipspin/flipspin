import { useTranslation } from 'react-i18next'
import { AccuracyPage } from '../../analysis/AccuracyPage'
import { useSettings } from '../context'
import { Page } from './Head'
export function Accuracy() {
  const { t } = useTranslation()
  const { go, admin } = useSettings()
  return <Page id="accuracy" before={<div className="cx-crumb"><button type="button" className="ks-link" onClick={() => go('complementos')}>{t("Engines")}</button><span>›</span>{admin ? <button type="button" className="ks-link" onClick={() => go('analisis')}>{t("Analysis")}</button> : <span>{t("Analysis")}</span>}<span>›</span></div>}><AccuracyPage /></Page>
}
