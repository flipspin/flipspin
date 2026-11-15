import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { apiGet, apiPost } from '../data'
import { useAnalysisSummary } from '../analysis/data'
import { OutdatedStatus } from '../analysis/OutdatedStatus'

export function LibraryAnalysis() {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [started, setStarted] = useState(false)
  const [failed, setFailed] = useState(false)
  const requestId = useRef<string | null>(null)
  const summary = useAnalysisSummary(true)
  const preview = useQuery({ queryKey: ['analysis', 'preview', 'outdated'], queryFn: ({ signal }) => apiGet('/api/analysis/runs/preview', { params: { query: { mode: 'outdated' } }, signal }), retry: false })
  if (preview.data?.size === 0 && !summary.data?.outdated) return null
  async function start() {
    setBusy(true); setFailed(false)
    requestId.current ??= crypto.randomUUID()
    try { await apiPost('/api/analysis/runs', { body: { requestId: requestId.current, mode: 'outdated', scope: 'library' } }); setStarted(true) }
    catch { setFailed(true) }
    finally { setBusy(false) }
  }
  return <div className="music-analysis-row">
    {summary.data?.outdated && !started ? <OutdatedStatus count={summary.data.outdated} /> : <span>{t('Analysis')} · <span className="music-status"><i />{started ? t('Started') : t('Not started')}</span></span>}
    {!started && <button type="button" className="music-button" disabled={busy} onClick={() => void start()}>{t('Analyse now')}</button>}
    {failed && <span role="alert" title={t('Retry in Settings → Background work if no Analysis helper is available.')}>{t('Could not start analysis')}</span>}
  </div>
}
