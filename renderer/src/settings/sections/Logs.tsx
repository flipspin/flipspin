/**
 * Server and local logs share tail, search, copy and refresh controls.
 * The native bridge selects local sources by key; it never accepts a path.
 */
import { useEffect, useId, useMemo, useState } from 'react'
import { Check, Copy, FolderOpen, RefreshCw, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { useQuery } from '@tanstack/react-query'
import { bridge, hasBridge } from '../../bridge'
import { reportError } from '../../lib/log'
import { clearLog, type LogFile } from '../gateways'
import { useSettings } from '../context'
import { ModalLayer } from '../../ui/react/components/ModalLayer'
import { useHeld } from '../../ui/react/useHeld'
import { LOG_WINDOW, useLog } from '../data'
import { formatBytes } from '../format'
import { levelWord, parseLog, sourceWord } from '../logs'
import { QueryFailure, Seg, Skel } from '../parts'
import { Page } from './Head'

function when(at: Date | null): string {
  // A line with no time shows none (optional fact, left out).
  if (!at) return ''
  const time = new Intl.DateTimeFormat(document.documentElement.lang || 'es', { hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
  return time
}

function CopyLog({ text, line = false, disabled = false }: { text: string; line?: boolean; disabled?: boolean }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true) }
    catch (error) { reportError('settings', { userMessage: t("Could not copy"), error }) }
  }
  return <button className={`ks-btn ks-btn--sm ks-btn--icon${line ? ' settings-log__copy' : ''}`} type="button"
    aria-label={line ? t("Copy line") : t("Copy")} title={line ? t("Copy line") : t("Copy the lines as they are to report a problem")}
    disabled={disabled} onClick={() => void copy()}>
    {copied ? <Check className="i" aria-hidden /> : <Copy className="i" aria-hidden />}
  </button>
}

export function Logs(): React.JSX.Element {
  const { t } = useTranslation()
  const { admin } = useSettings()
  const [clearing, setClearing] = useState<LogFile | null>(null)
  const heldFile = useHeld(clearing)
  const [busy, setBusy] = useState(false)
  const [clearError, setClearError] = useState<unknown>(null)
  const titleId = useId()
  const localSources = useQuery({ queryKey: ['local-log-sources'], networkMode: 'always', queryFn: () => bridge().invoke('log:sources', undefined), enabled: hasBridge() })
  const [file, setFile] = useState<LogFile>('errors')
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const log = useLog(file, query, true)
  const entries = useMemo(() => parseLog(log.data?.lines ?? []), [log.data])

  const openFolder = async () => {
    if (file !== 'desktop' && file !== 'helper') return
    try { await bridge().invoke('log:open-folder', { source: file }) }
    catch (error) { reportError('settings', { userMessage: t("Could not open the folder"), error }) }
  }

  const names = { errors: t("Errors"), app: t("All_neutral"), desktop: t("This computer_computer"), helper: t("Helper") }
  const clear = async () => {
    if (!clearing || busy) return
    const selected = clearing
    setBusy(true)
    setClearError(null)
    try {
      await clearLog(selected)
      await log.refetch()
      setClearing(null)
    } catch (error) { setClearError(error); setClearing(null) }
    finally { setBusy(false) }
  }

  return (
    <Page id="registro">
      <form
        className="settings-logbar"
        onSubmit={(event) => {
          event.preventDefault()
          setQuery(draft.trim())
        }}
      >
        <Seg<LogFile>
          label={t("What to show")}
          value={file}
          onChange={(next) => { setFile(next); setClearError(null) }}
          options={[
            { value: 'errors', label: t("Errors") },
            { value: 'app', label: t("All_neutral") },
            ...(hasBridge() ? [{ value: 'desktop' as const, label: t("This computer_computer") }] : []),
            ...(localSources.data?.helper ? [{ value: 'helper' as const, label: t("Helper") }] : []),
          ]}
        />
        <input className="ks-field settings-logbar__q" type="search" placeholder={t("Filter")} aria-label={t("Filter the log")} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => setQuery(draft.trim())} />
        <button className="ks-btn ks-btn--sm ks-btn--icon" type="button" aria-label={t("Refresh")} title={t("Refresh")} onClick={() => void log.refetch()}>
          <RefreshCw className="i" aria-hidden />
        </button>
        <CopyLog text={(log.data?.lines ?? []).join('\n')} disabled={!log.data?.lines.length} />
        {file === 'desktop' || file === 'helper' ? <button className="ks-btn ks-btn--sm ks-btn--icon" type="button" aria-label={t("Open folder")} title={t("Open folder")} onClick={() => void openFolder()}><FolderOpen className="i" aria-hidden /></button> : null}
        {file === 'desktop' || file === 'helper' || admin === true ? <button className="ks-btn ks-btn--sm ks-btn--icon" type="button" aria-label={t("Clear")} title={t("Clear")} disabled={!log.data?.sizeBytes || busy} onClick={() => { setClearError(null); setClearing(file) }}><Trash2 className="i" aria-hidden /></button> : null}
      </form>
      {clearError ? <QueryFailure error={clearError} forbiddenAsOlder what={t("the log")} onRetry={() => { setClearError(null); setClearing(file) }} /> : null}
      <div className="settings-loglist">
        {log.isPending ? (
          <Skel rows={4} label={t("Loading the log")} />
        ) : log.isError ? (
          <QueryFailure error={log.error} what={t("the log")} onRetry={() => void log.refetch()} />
        ) : entries.length === 0 ? (
          <div className="settings-alt">
            <span className="z-say">
              {query
                ? t("Nothing matches “{{q}}”.", { q: query })
                : file === 'errors'
                  ? t("No errors in the last {{n}} lines.", { n: LOG_WINDOW })
                  : t("The log is empty.")}
            </span>
            {query ? (
              <button
                className="ks-btn ks-btn--sm"
                type="button"
                onClick={() => {
                  setDraft('')
                  setQuery('')
                }}
              >
                {t("Clear filters")}
              </button>
            ) : null}
          </div>
        ) : (
          <div className="settings-block__body">
            {entries.map((entry, index) => {
              const level = levelWord(entry.level)
              return (
                <div className="settings-logrow" key={`${entry.level}-${entry.message}-${index}`}><details className="settings-log">
                  <summary title={t("All_neutral")}>
                    <span className="z-mono settings-log__time" title={entry.at ? entry.at.toLocaleString(document.documentElement.lang || 'es') : t("The nest’s operating system could not report this detail.")}>{when(entry.at)}</span>
                    <span className="settings-log__msg">{entry.message}{entry.count > 1 ? ` ×${entry.count}` : ''}</span>
                    <span className="settings-log__meta"><b className={`settings-level settings-level--${level.tone}`}>{t(level.word)}</b> <span className="z-mono">{file === 'desktop' ? t("This computer_computer") : file === 'helper' ? t("Helper") : t(sourceWord(entry.module))}</span></span>
                  </summary>
                  <pre className="settings-log__raw">{entry.raw}</pre>
                </details><CopyLog text={entry.raw} line /></div>
              )
            })}
          </div>
        )}
      </div>
      {log.data ? (
        <span className="settings-foot z-mono">
          {t("{{n}} lines read · {{size}} on disk", { n: log.data.scanned || log.data.lines.length, size: formatBytes(log.data.sizeBytes) })}
        </span>
      ) : null}
      <ModalLayer open={clearing !== null} onClose={() => setClearing(null)} role="alertdialog" dismissible={!busy}
        scrimClassName="krobi-settings z-root settings-log-scrim z-scrim" className="settings krobi-settings z-root z-modal settings-modal" data-profile="krobi" aria-labelledby={titleId}>
        <h3 id={titleId}>{t("Clear the {{name}}?", { name: names[heldFile ?? file] })}</h3>
        <div className="settings-modal__do">
          <button className="ks-btn ks-btn--ghost" type="button" disabled={busy} onClick={() => setClearing(null)}>{t("Cancel")}</button>
          <button className="ks-btn ks-btn--danger" type="button" disabled={busy} onClick={() => void clear()}>{t("Clear")}</button>
        </div>
      </ModalLayer>
    </Page>
  )
}
