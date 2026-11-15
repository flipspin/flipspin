import type { TFunction } from 'i18next'
import type { Attention } from './useAttention'

/** The button announces the condition as well as the dot, including to AT
 * that presents a button's descendants as plain text. */
export function attentionLabel(value: Attention | undefined, t: TFunction): string | null {
  if (!value?.flag || !value.flagTone) return null
  return value.flag === 'version' ? t("New version available") : value.flagTone === 'bad' ? t("Helper offline · work waiting") : t("Helper needs attention · work waiting")
}
