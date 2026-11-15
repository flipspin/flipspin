import { poll } from '../data/poll'
/** Shared config snapshot: navigation, Resumen and the section read the same save. */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { apiGet, apiPost, apiPut, isApiError, queryKeys, type ApiData } from '../data'
import { useSettings } from './context'
import { useToast } from './parts'

export type ServerConfig = ApiData<'/api/server/config', 'get'>
export type Setting = ServerConfig['groups'][number]['settings'][number]
export const CAPACITY_KEYS = ['KROBI_MAX_CONCURRENT_DOWNLOADS', 'KROBI_MAX_CONCURRENT_JOBS'] as const
// Keyed profiles avoid applying retired positional values from older nests.
export function capacityPresets(config: ServerConfig): Record<string, Record<string, number>> {
  const active = config.machine.capacityPresets
  return active?.light && active?.normal ? active : {
    light: { KROBI_MAX_CONCURRENT_DOWNLOADS: 1, KROBI_MAX_CONCURRENT_JOBS: 1 },
    normal: { KROBI_MAX_CONCURRENT_DOWNLOADS: 2, KROBI_MAX_CONCURRENT_JOBS: 2 },
  }
}
export const SECURITY_KEYS = ['KROBI_REQUIRE_SETUP_TOKEN', 'KROBI_API_TOKEN', 'KROBI_ALLOW_UNAUTHENTICATED_REMOTE', 'KROBI_ALLOW_REMOTE_LOCAL_ACTIONS']

function useConfigController() {
  const { admin, refreshServer } = useSettings()
  const { t } = useTranslation()
  const toast = useToast()
  const client = useQueryClient()
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [requested, setRequested] = useState(false)
  const [slow, setSlow] = useState(false)
  const [restartError, setRestartError] = useState('')
  const statusRef = useRef(false)
  const query = useQuery({
    queryKey: queryKeys.server.config(),
    queryFn: ({ signal }) => apiGet('/api/server/config', { signal }),
    select: data => ({ ...data, groups: data.groups.map(group => ({ ...group, settings: group.settings.filter(row => !['KROBI_ANALYSIS_WORKERS', 'KROBI_ANALYSIS_AUTO_LIBRARY', 'KROBI_ANALYSIS_AUTO_UPGRADE', 'KROBI_NEST_LIBRARY_START_HOUR', 'KROBI_NEST_LIBRARY_END_HOUR'].includes(row.key)) })) }),
    enabled: admin === true,
    staleTime: 10_000,
    refetchInterval: () => poll('restarting', requested || statusRef.current, 2000, false),
  })
  // Read status over HTTP even on desktop: it carries the additive restarting flag.
  const status = useQuery({
    queryKey: queryKeys.server.configStatus(),
    queryFn: async ({ signal }) => {
      const body = await apiGet('/api/status', { signal })
      return typeof body === 'object' && body !== null && 'restarting' in body && body.restarting === true
    },
    enabled: admin === true,
    retry: false,
    refetchInterval: q => poll('restarting', requested || q.state.data === true, 2000, false),
  })
  statusRef.current = status.data === true
  const restarting = requested || status.data === true
  const restartStartedAt = useRef<number | null>(null)
  useEffect(() => {
    if (status.data === true && restartStartedAt.current === null) {
      restartStartedAt.current = Date.now()
      setRequested(true)
    }
    const started = restartStartedAt.current
    // Both routes must answer after the restart began. Cached false/status or
    // stale config during a connection failure cannot be mistaken for recovery.
    if (started !== null && status.data === false && !status.isError &&
        !query.isError && query.data?.restart.pending.length === 0 &&
        status.dataUpdatedAt > started && query.dataUpdatedAt > started && !query.isFetching) {
      setRequested(false)
      restartStartedAt.current = null
      toast(t("The nest restarted · changes applied"))
      refreshServer()
      void client.invalidateQueries({ queryKey: queryKeys.server.handshake() })
    }
  }, [status.data, status.isError, status.dataUpdatedAt, query.data, query.isError, query.dataUpdatedAt, query.isFetching, toast, t, refreshServer, client])
  useEffect(() => {
    if (!restarting) { setSlow(false); return }
    const timer = setTimeout(() => setSlow(true), 60_000)
    return () => clearTimeout(timer)
  }, [restarting])

  async function save(changes: Record<string, unknown>, undoable = true) {
    if (savingRef.current || restarting || !query.data) return
    savingRef.current = true
    setSaving(true)
    setErrors({})
    const rows = query.data.groups.flatMap((g) => g.settings)
    const previous = Object.fromEntries(rows.filter((r) => r.key in changes).map((r) => [r.key, query.data.restart.pending.includes(r.key) ? r.pendingValue : r.value]))
    try {
      await client.cancelQueries({ queryKey: queryKeys.server.config() })
      const result = await apiPut('/api/server/config', { body: { changes } })
      client.setQueryData(queryKeys.server.config(), result)
      if ("KROBI_YTDLP_AUTO_UPDATE" in changes) void client.invalidateQueries({ queryKey: queryKeys.server.providers() })
      if ("KROBI_UPDATE_CHECK" in changes) void client.invalidateQueries({ queryKey: queryKeys.server.update() })
      toast(t("Saved"), undoable ? { undo: () => void save(previous, false) } : undefined)
    } catch (error) {
      const detail = isApiError(error) && typeof error.body === 'object' && error.body !== null && 'detail' in error.body ? error.body.detail : null
      const d = typeof detail === 'object' && detail !== null ? detail as Record<string, unknown> : {}
      let word = t("Could not save to the nest. The value did not change.")
      if (d.code === 'env-locked') word = t("Configured in the nest’s file.")
      if (d.code === 'read-only') word = t("This value cannot be changed here.")
      if (d.code === 'unknown-key') word = t("This nest does not support this setting.")
      if (d.code === 'out-of-range') word = t("Between {{min}} and {{max}}.", { min: d.min, max: d.max })
      if (d.code === 'not-a-choice') word = t("Choose one of the available options.")
      if (d.code === 'invalid-ffmpeg') word = t("The path does not contain a runnable ffmpeg.")
      if (d.code === 'bad-type') word = t("The value does not have the expected format.")
      const keys = typeof d.key === 'string' && rows.some((r) => r.key === d.key) ? [d.key] : Object.keys(changes)
      setErrors(Object.fromEntries(keys.map((key) => [key, word])))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  async function restart(when: 'idle' | 'now') {
    setRestartError('')
    try {
      await apiPost('/api/server/restart', { body: { when } })
      restartStartedAt.current = Date.now()
      setRequested(true)
      void status.refetch()
      return true
    } catch {
      setRestartError(t("Could not restart the nest. Try again."))
      return false
    }
  }
  return { query, saving, errors, save, restarting, slow, restart, restartError }
}
const ConfigContext = createContext<ReturnType<typeof useConfigController> | null>(null)
export function ConfigProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const value = useConfigController()
  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>
}
export function useConfig() {
  const value = useContext(ConfigContext)
  if (!value) throw new Error('useConfig requires ConfigProvider')
  return value
}
