import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { apiGet, apiPut } from '../../data'
import type { SchemaComputeSummary, SchemaComputer, SchemaKindSummary, SchemaKindUpdate, SchemaWorkerLimits } from '../../api/generated/schema'
import { useToast } from '../parts'
import { msg } from '../../i18n'

export type Computer = SchemaComputer
export type Kind = SchemaKindSummary
export type Limits = SchemaWorkerLimits
export const computeKey = ['compute', 'summary'] as const
export const kindNames: Record<string, string> = { align: msg("Lyrics sync_synchronization"), stems: msg('Stems'), analysis: msg("Analysis") }
export const placements = { helpers: msg("Helpers only"), 'helpers-then-nest': msg("Helpers, then the nest"), anywhere: msg("Anywhere") }
export const reasons: Record<string, string> = {
  paused: msg("Paused"), off: msg("Off"), hours: msg("Outside hours"), battery: msg("Waiting for power"),
  thermal: msg("Paused · too hot"), 'no-engine': msg("No engine installed"), 'no-cgroup': msg("Cannot limit the process"),
  memory: msg("Needs 8 GB of memory"), 'no-helper': msg("Needs a helper"),
  'no-capable-helper': msg("No capable computer"), 'helpers-offline': msg("Waiting for a computer"),
  'helpers-busy': msg("Computers busy"), 'engine-disabled': msg("Engine disabled"),
}
export function useCompute(enabled = true, _waiting = false) {
  const query = useQuery({ queryKey: computeKey, queryFn: ({ signal }) => apiGet('/api/compute/summary', { signal }), enabled })
  return query
}
export function useComputeActions() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  async function act(action: () => Promise<unknown>) {
    setBusy(true)
    try { await action(); await queryClient.invalidateQueries({ queryKey: computeKey }); return true }
    catch { toast(t("Could not save the change"), { err: true }); return false }
    finally { setBusy(false) }
  }
  return {
    busy, act,
    kind: (kind: Kind['kind'], body: SchemaKindUpdate) => act(() => apiPut('/api/compute/kinds/{kind}', { params: { path: { kind } }, body })),
    computer: (computer: Computer, values: Partial<Limits>) => act(() => apiPut('/api/compute/computers/{identity}', { params: { path: { identity: computer.nest ? 'nest' : computer.id } }, body: { ...computer.limits, ...values } })),
    pause: (paused: boolean) => act(() => apiPut('/api/compute/pause', { body: { paused } })),
  }
}
export function computerState(computer: Computer): string {
  if (computer.versionState === 'too-old') return msg("Too old for this nest")
  if (computer.limits.paused) return msg("Paused")
  if (computer.limits.pace === 'off') return msg("Off")
  if (computer.pausedReason === 'thermal') return msg("Cooling down")
  if (computer.pausedReason) return reasons[computer.pausedReason] ?? msg("Paused")
  if (computer.disabledReason) return reasons[computer.disabledReason] ?? msg("Unavailable")
  return ({ working: msg("Working"), idle: msg("Ready"), asleep: msg("Asleep_masculine"), closed: msg("Closed_masculine"), offline: msg("Offline"), outdated: msg("Update Flipspin"), revoked: msg("Revoked") })[computer.state]
}
export function hours(limits: Limits): string {
  if (!limits.window) return 'Any time'
  const time = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
  return `${time(limits.window.startMinute)}–${time(limits.window.endMinute)}`
}
export function oldest(at: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() / 1000 - at) / 60))
  return minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 1440)} d`
}
