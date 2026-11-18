import { useTranslation } from 'react-i18next'
import './analysis.css'

/** Mood is a rough guess from tempo and energy (it failed the owner's pair check),
 *  so it always wears the estimate look: amber, ≈, dotted underline, tooltip. */
export function MoodEstimate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation()
  const hint = t('Rough guess from tempo and energy')
  return <span className="analysis-value analysis-value--estimated" title={hint}>
    <span aria-hidden="true">≈ </span><span className="analysis-value__number">{children}</span><span className="k-sr-only">{`, ${hint}`}</span>
  </span>
}
