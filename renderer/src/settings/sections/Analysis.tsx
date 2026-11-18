import { useTranslation } from 'react-i18next'
import { ReviewEstimates } from '../../analysis/ReviewEstimates'
import { Missing } from '../../ui/react/components/Missing'
import { useSettings } from '../context'
import { Page } from './Head'
import { AnalysisControls } from '../background/AnalysisControls'

export function Analysis(): React.JSX.Element {
  const { admin } = useSettings()
  if (!admin) return <Missing kind="noAccess" />
  return <Page id="analisis"><AnalysisControls /></Page>
}

/** Library health and legacy links retain their direct review destination. */
export function Estimates(): React.JSX.Element {
  const { t } = useTranslation()
  const { admin, host, go } = useSettings()
  if (!admin) return <Missing kind="noAccess" />
  return <section className="settings-page" aria-label={t("Review estimates")}><div className="cx-crumb"><button type="button" className="ks-link" onClick={() => go('analisis')}>{t("Analysis")}</button><span>›</span></div><ReviewEstimates onPlay={row => host.playEstimate?.(row.relPath)} onTags={row => host.openEstimateTags?.(row.relPath)} onOpenInfo={host.openEstimateInfo ? row => host.openEstimateInfo?.(row.relPath) : undefined} /></section>
}
