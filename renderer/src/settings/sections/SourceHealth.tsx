import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { apiPost, queryKeys } from '../../data'
import type { Provider } from '../data'
import { Word, Switch, useToast } from '../parts'
import { sourceState, sourceTooltip, sourceWord } from '../sourceHealth'

export function SourceStatus({ provider }: { provider: Provider }) {
  const { t } = useTranslation()
  const state = sourceState(provider)
  return <Word tone={state === 'ready' ? 'ok' : state === 'busy' ? 'warn' : 'bad'} title={sourceTooltip(provider, t)}>{sourceWord(provider, t)}</Word>
}

export function RetrySource({ provider }: { provider: Provider }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  async function retry() {
    setBusy(true)
    try {
      await client.cancelQueries({ queryKey: queryKeys.server.providers() })
      const health = await apiPost('/api/providers/{provider_id}/retry', { params: { path: { provider_id: provider.id } } })
      client.setQueryData<Provider[]>(queryKeys.server.providers(), rows => rows?.map(row => row.id === provider.id ? { ...row, health } : row))
      await client.invalidateQueries({ queryKey: queryKeys.server.providers() })
    } catch {
      toast(t('Could not retry {{name}}', { name: provider.name }), { err: true })
    } finally { setBusy(false) }
  }
  return <button className="ks-link" type="button" disabled={busy} title={t('Clears the wait and lets the next download run now')} onClick={() => void retry()}>{t('Try now')}</button>
}

export function SourceAction({ provider, action, value }: { provider: Provider; action: { id: string; label: string }; value?: boolean }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  async function run() {
    setBusy(true)
    try {
      await client.cancelQueries({ queryKey: queryKeys.server.providers() })
      const status = await apiPost('/api/sources/{id}/action', { params: { path: { id: provider.id } }, body: { id: action.id, ...(value == null ? {} : { value: !value }) } })
      client.setQueryData<Provider[]>(queryKeys.server.providers(), rows => rows?.map(row => row.id === provider.id ? { ...row, status } : row))
      await client.invalidateQueries({ queryKey: queryKeys.server.providers() })
    } catch { toast(t('Could not run the action'), { err: true }) }
    finally { setBusy(false) }
  }
  return value == null ? <button className="ks-link" type="button" disabled={busy} onClick={() => void run()}>{action.label}</button>
    : <Switch label={action.label} checked={value} disabled={busy} onChange={() => void run()} />
}
