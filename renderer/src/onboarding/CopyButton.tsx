/** Clipboard failures leave the control usable without success feedback. */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '../ui/react/components/Button'

/** Wizard styling stays inside `.krobi-onboarding`; other screens use the shared Button. */
export function CopyButton({ text, tip, nativeTip = false, look = 'app' }: { text: string; tip?: string; nativeTip?: boolean; look?: 'app' | 'wizard' }): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1400)
      })
      .catch(() => undefined)
  }
  const tipProps = {
    'data-tip': nativeTip ? undefined : tip,
    title: nativeTip ? tip : undefined,
    'data-tip-pos': tip ? 'end' : undefined,
  }
  if (look === 'wizard') {
    return (
      <button type="button" className="kob-btn kob-btn--sm" {...tipProps} onClick={copy}>
        {copied ? t("Copied") : t("Copy")}
      </button>
    )
  }
  return (
    <Button size="sm" {...tipProps} onClick={copy}>
      {copied ? t("copied") : t("copy")}
    </Button>
  )
}
