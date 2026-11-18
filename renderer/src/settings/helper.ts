/** Snapshot → words shared by the two processing cards and contract check 12. */
import { msg } from '../i18n'
import type { TFunction } from 'i18next'
import { enginePhase } from '../lyrics/phase'
import type { SchemaMacWorker, SchemaLyricsEngineResponse } from '../api/generated/schema'
import type { Tone } from './parts'

export type Helper = SchemaMacWorker
export type JobKind = 'align' | 'transcribe' | 'stems' | 'analysis'

export const HELPER_STATES: Record<Helper['state'], { word: string; tone: Tone }> = {
  working: { word: msg("Working"), tone: 'ok' },
  idle: { word: msg("Available"), tone: 'ok' },
  asleep: { word: msg("Asleep_resting"), tone: 'none' },
  closed: { word: msg("Flipspin closed"), tone: 'none' },
  offline: { word: msg("Offline"), tone: 'bad' },
  outdated: { word: msg("Outdated_masculine"), tone: 'warn' },
  revoked: { word: msg("No access"), tone: 'bad' },
}
export const HELPER_JOBS = [
  { kind: 'align', word: msg("Sync lyrics"), tip: msg("Adjusts each lyric line to the moment it is sung") },
  { kind: 'stems', word: msg("Split into stems_split"), tip: msg("Vocals, drums, bass and other instruments, each on its own track") },
] as const

export function helperKind(accel: Helper['accel']): string {
  return accel === 'mlx' ? msg('Apple Silicon') : accel === 'cuda' ? msg('Nvidia') : msg("CPU · slow")
}
export function helperKindTip(accel: Helper['accel']): string {
  return accel === 'mlx' ? msg("Uses the computer’s chip") : accel === 'cuda' ? msg("Uses the graphics card") : msg("Without a graphics card: uses the processor. It works, but takes longer.")
}
export function waitWord(reason: SchemaLyricsEngineResponse['waitReason']): string {
  switch (reason) {
    case 'no-capable-helper': return msg("No helper can do this job")
    case 'helpers-offline': return msg("The helpers are offline")
    case 'helpers-busy': return msg("All helpers are working")
    default: return msg("No helper is processing for the nest")
  }
}
export function capable(helper: Pick<Helper, 'memoryBytes' | 'jobs' | 'os' | 'accel'>, kind: JobKind): boolean {
  if (kind === 'analysis') return helper.jobs?.includes('analysis') === true
  const memoryOK = helper.memoryBytes == null ? helper.os === 'macos' && helper.accel === 'mlx' : helper.memoryBytes >= 8 * 2 ** 30
  return memoryOK && helper.jobs?.includes(kind) === true
}
function measured(helper: Pick<Helper, 'speed'>, kind: JobKind): number | null {
  const speed = helper.speed?.[kind]
  const value = speed?.medianSecondsPerMinute
  return speed?.samples >= 3 && Number.isFinite(value) && value >= 0 ? value : null
}
/** Same preference as the nest: a real helper first; measured cohorts, then GPU. */
export function fastestHelper(helpers: Helper[], kind: JobKind): Helper | null {
  return helpers.filter(h => (h.state === 'idle' || h.state === 'working') && capable(h, kind)).reduce<Helper | null>((best, h) => {
    if (!best) return h
    if (h.nest !== best.nest) return best.nest ? h : best
    const a = measured(h, kind), b = measured(best, kind)
    if (a !== null && b !== null) return a < b ? h : best
    return h.accel !== 'cpu' && best.accel === 'cpu' ? h : best
  }, null)
}
export function helperSpeed(helper: Pick<Helper, 'speed'> | null, kind: JobKind): { value: number | null; reason: string } {
  return { value: helper ? measured(helper, kind) : null, reason: helper ? msg("Not measured yet") : msg("No helper is processing for the nest") }
}
export function helperHardware(helper: Pick<Helper, 'chip' | 'gpu' | 'memoryBytes' | 'os' | 'macos'>): string {
  return [helper.gpu || helper.chip, helper.memoryBytes ? `${Number((helper.memoryBytes / 2 ** 30).toFixed(1))} GB` : null,
    helper.os === 'macos' ? ['macOS', helper.macos].filter(Boolean).join(' ') : helper.os === 'windows' ? 'Windows' : helper.os === 'linux' ? 'Linux' : null].filter(Boolean).join(' · ')
}

/** The card names alignment by the job the person asked for. */
export function helperPhase(phase: string, t: TFunction): string {
  return phase === 'alineando' ? t("syncing") : enginePhase(phase, t)
}
