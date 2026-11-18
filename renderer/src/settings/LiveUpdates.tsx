import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStreamLoss, useStreamState } from '../data/streamState'
import { Dot, Word } from './parts'

function clock(since: number, language: string): string {
  return new Date(since).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function LiveUpdatesRow(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { state, since } = useStreamState()
  const loss = useStreamLoss()
  const connected = state === 'connected'
  return <div className="ks-row" aria-live="polite">
    <div className="ks-l" title={t('Changes on the nest reach this app as they happen')}>
      <b>{t('Live updates')}</b>
      {state !== 'auth' ? <span>{t('since {{time}}', { time: clock(loss?.since ?? since, i18n.language) })}</span> : null}
    </div>
    <div className="ks-c">
      <Word tone={connected ? 'ok' : state === 'auth' ? 'bad' : 'warn'}>{connected ? t('Connected') : state === 'auth' ? t('Signed out') : t('Reconnecting')}</Word>
    </div>
  </div>
}

/** The current state gates rendering, so reconnect clears the word immediately. */
export function LiveUpdatesLost(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const loss = useStreamLoss()
  const [shownLoss, setShownLoss] = useState<typeof loss>(null)
  useEffect(() => {
    if (!loss) return
    const timer = window.setTimeout(() => setShownLoss(loss), Math.max(0, 1000 - (Date.now() - loss.since)))
    return () => window.clearTimeout(timer)
  }, [loss])
  return loss && shownLoss === loss ? <span role="status" className="settings-word settings-word--warn settings-live-lost" title={t('Live updates lost at {{time}} · reconnecting', { time: clock(loss.since, i18n.language) })}>
      <Dot tone="warn" />{t('Live updates lost')}
    </span> : <></>
}
