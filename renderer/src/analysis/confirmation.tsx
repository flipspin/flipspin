import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { apiGet, apiPut, isApiError, serverDetail } from '../data'
import type { SchemaAnalysisView } from '../api/generated/schema'
import { reportError as reportFailure } from '../lib/log'
import { notify } from '../ui/notifications'
import { analysisKeys } from './data'
import { keyCode, keyName } from './keys'
import type { BpmFactor } from './BpmScale'

type SaveOptions = { message?: string; undoValue?: string | number | null; undo?: boolean }

export function ConfirmEstimate({ field, value, song, disabled, onConfirm }: { field: 'key' | 'bpm'; value: string | number; song?: string; disabled?: boolean; onConfirm: () => void }) {
  const { t } = useTranslation()
  const label = field === 'key' ? t("Confirm key {{value}}", { value: `${keyCode(String(value))} · ${t(keyName(String(value)))}` }) : t("Confirm {{bpm}} BPM", { bpm: value })
  return <button type="button" className="k-btn analysis-confirm" data-confirm={field} aria-label={song ? `${label} · ${song}` : label} disabled={disabled} onClick={onConfirm}><Check size={14} aria-hidden />{t("Confirm")}</button>
}

/** All surfaces share one sticky notification and the same revision-aware reset. */
export function useAnalysisConfirmation({ onError, onConflict }: { onError?: (error: unknown) => void; onConflict?: () => void } = {}) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [message, setMessage] = useState('')
  const reportError = (error: unknown) => {
    const body = isApiError(error) ? error.body : null
    const detail = body && typeof body === 'object' && 'detail' in body ? body.detail : null
    const validation = Array.isArray(detail) ? detail.map(item => item.msg).filter(Boolean).join(' · ') : null
    setMessage(serverDetail(error) || validation || (isApiError(error) ? error.userMessage : t("Could not save the change")))
    if (onError) onError(error)
    else if (!isApiError(error) || error.status !== 422) reportFailure('analysis', { userMessage: t("Could not save the change"), error })
  }
  const save = async (relPath: string, rev: number, field: 'key' | 'bpm', value: string | number | null, changed: (view: SchemaAnalysisView) => void, song?: string, options: SaveOptions = {}): Promise<boolean> => {
    if (pending.current) return false
    pending.current = true
    setBusy(true)
    setMessage('')
    try {
      await client.cancelQueries({ queryKey: analysisKeys.estimates })
      await client.cancelQueries({ queryKey: analysisKeys.track(relPath) })
      const next = await apiPut('/api/analysis/{relPath}/fixed', { params: { path: { relPath } }, body: { rev, [field]: value } })
      client.setQueryData(analysisKeys.track(relPath), next)
      changed(next)
      void client.invalidateQueries({ queryKey: ['library'] })
      void client.invalidateQueries({ queryKey: analysisKeys.summary })
      if (value !== null && !options.undo) notify({ id: 'analysis-confirmation', level: 'success', sticky: true,
        message: options.message ?? (song ? t(field === 'key' ? "{{song}} · key confirmed" : "{{song}} · BPM confirmed", { song }) : t(field === 'key' ? "Key confirmed" : "BPM confirmed")),
        action: { label: t("Undo"), onSelect: () => { void save(relPath, next.rev, field, options.undoValue ?? null, changed, undefined, { undo: true }) } },
      })
      return true
    } catch (error) {
      if (isApiError(error) && error.status === 409) {
        try {
          const next = await apiGet('/api/analysis/{relPath}', { params: { path: { relPath } } })
          client.setQueryData(analysisKeys.track(relPath), next)
          changed(next)
          void client.invalidateQueries({ queryKey: ['library'] })
          void client.invalidateQueries({ queryKey: analysisKeys.summary })
          onConflict?.()
          notify({ id: 'analysis-confirmation', message: t("The value changed on the nest. The latest version was loaded.") })
        } catch (reloadError) { reportError(reloadError) }
      } else reportError(error)
      return false
    } finally { pending.current = false; setBusy(false) }
  }
  const scaleBpm = (relPath: string, rev: number, value: number, factor: BpmFactor, previousFixed: number | null, changed: (view: SchemaAnalysisView) => void) => save(relPath, rev, 'bpm', value, changed, undefined, {
    message: t(factor === 2 ? "BPM doubled to {{value}}" : "BPM halved to {{value}}", { value }),
    undoValue: previousFixed,
  })
  return { busy, save, scaleBpm, message }
}
