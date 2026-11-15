/** Shared install attempts keep the sheet and Overview in step across navigation. */
import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiPost, isApiError, queryKeys } from '../data'
import type { components } from '../api/generated/schema'
import { watchChanges } from '../data/changeListeners'

export type KnownSource = components['schemas']['KnownSource']
type InstallRequest = components['schemas']['InstallRequest']
type Attempt = { id?: string; starting?: boolean; error?: string }
const ATTEMPTS = ['source-install-attempts']

export function useKnownSources(enabled = true) {
  return useQuery({ queryKey: ['known-sources'], enabled,
    queryFn: ({ signal }) => apiGet('/api/sources/known', { signal }) })
}

export function useSourceAttempts() {
  return useQuery({ queryKey: ATTEMPTS, queryFn: (): Record<string, Attempt> => ({}),
    initialData: {}, enabled: false, gcTime: Infinity }).data
}

export function useSourceInstall(key: string, progressId?: string) {
  const client = useQueryClient()
  const attempt = useSourceAttempts()[key]
  const id = attempt?.id ?? progressId
  const jobs = useQuery({ queryKey: ['source-install', id], enabled: Boolean(id),
    queryFn: ({ signal }) => apiGet('/api/jobs', { signal }),
  })
  const refetch = jobs.refetch
  useEffect(() => watchChanges(['jobs'], () => { if (id) void refetch() }, false), [id, refetch])
  const job = jobs.data?.jobs.find(row => row.id === id)
  const terminal = job?.endedAt != null
  const failed = Boolean(attempt?.error || (terminal && job?.state !== 'succeeded'))
  const details = useQuery({ queryKey: ['source-install', id, 'failure'], enabled: Boolean(id && failed),
    queryFn: ({ signal }) => apiGet('/api/jobs/{job_id}/items', { params: { path: { job_id: id! } }, signal }),
  })
  const failure = details.data?.items.find(item => item.state === 'failed')
  const reason = attempt?.error || (typeof failure?.detail.error === 'string' ? failure.detail.error : failure?.reason) || ''
  useEffect(() => {
    if (!terminal) return
    for (const queryKey of [queryKeys.server.extensions(), queryKeys.server.providers(), ['missing-sources'], ['known-sources']]) {
      void client.invalidateQueries({ queryKey })
    }
  }, [terminal, client])
  function setAttempt(value: Attempt) {
    client.setQueryData<Record<string, Attempt>>(ATTEMPTS, previous => ({ ...previous, [key]: value }))
  }
  async function install(body: InstallRequest) {
    if (attempt?.starting || (id && !terminal)) return
    setAttempt({ starting: true })
    try {
      const response = await apiPost('/api/sources/install', { body })
      setAttempt({ id: response.progress_id })
    } catch (error) {
      setAttempt({ error: isApiError(error) ? error.userMessage : String(error) })
    }
  }
  return { install, job, failed, reason, busy: Boolean(attempt?.starting || (id && !terminal)),
    succeeded: job?.state === 'succeeded', jobs }
}
