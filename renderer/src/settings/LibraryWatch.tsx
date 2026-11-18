import { useTranslation } from 'react-i18next'
import { useLibraryScan } from './libraryScansData'
import { QueryFailure, Skel, Word } from './parts'

export function LibraryCheckInterval({ seconds, watching }: { seconds: number; watching: boolean }): React.JSX.Element | null {
  const { t, i18n } = useTranslation()
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  const minutes = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 }).format(seconds / 60)
  return <>{watching ? t('full check every {{minutes}} min', { minutes }) : t('every {{minutes}} min', { minutes })}</>
}

export function LibraryWatchRow(): React.JSX.Element {
  const { t } = useTranslation()
  const scan = useLibraryScan()
  if (scan.isPending) return <Skel rows={1} label={t('Loading scan status')} />
  if (scan.isError) return <QueryFailure error={scan.error} what={t('scan status')} onRetry={() => void scan.refetch()} />
  const { watching, intervalSeconds, error } = scan.data
  const reason = !watching && error ? error === 'empty' || error === 'unavailable' ? t('Folder unavailable') : error : undefined
  return <div className="ks-row" aria-live="polite">
    <div className="ks-l"><b>{t('Library watch')}</b><span><LibraryCheckInterval seconds={intervalSeconds} watching={watching} /></span></div>
    <div className="ks-c"><Word tone={watching ? 'ok' : 'warn'} title={reason}>{watching ? t('Watching') : t('Not watching')}</Word></div>
  </div>
}
