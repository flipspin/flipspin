/** Show server identity beside account identity so users can tell which library
 * receives downloads and saved tracks, including when this desktop hosts a server. */
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import { useServerStatus } from '../settings'
import { useForcedOffline } from '../offline/mode'
import type { InstallState } from '../settings/useInstall'
import type { ServerStatus } from '../lib/ipc'

type Tone = 'remote' | 'local' | 'down' | 'unknown'

export interface NestStatus {
  tone: Tone
  label: string
  hint: string
  /** The dot's colour. */
  color: string
}

function describe(state: InstallState<ServerStatus | null>, t: TFunction, forced: boolean): Omit<NestStatus, 'color'> {
  if (forced) return { tone: 'unknown', label: t("Offline mode"), hint: '' }
  if (state.kind !== 'ready' || !state.value || state.value.connection.state === 'connecting') {
    return { tone: 'unknown', label: t("Connecting…"), hint: '' }
  }

  const status = state.value
  if (status.connection.state === 'unreachable') {
    return {
      tone: 'down',
      label: t("Offline"),
      hint: t("Your nest isn't answering right now."),
    }
  }

  // `mode`, not the address. A remote server *can* answer on a loopback
  // address through a tunnel, and a local one can be reached by its LAN name —
  // what matters is whether this app started it, because that is what decides
  // whose disk the music is on.
  if (status.mode === 'child') {
    return {
      tone: 'local',
      label: status.name || t("your nest"),
      hint: t("This computer is your nest. Your other devices can join it."),
    }
  }

  return {
    tone: 'remote',
    label: status.name || t("your nest"),
    // No phone apps in v1: nothing to add under the name.
    hint: '',
  }
}

const TONE_COLOR: Record<Tone, string> = {
  remote: 'var(--green)',
  local: 'var(--yellow)',
  down: 'var(--rose)',
  unknown: 'var(--ink-4)',
}

/**
 * The nest's state for whoever draws it; the header's account block reads
 * this rather than this module drawing a pill of its own. `color` is the dot.
 */
export function useNestStatus(): NestStatus {
  const { t } = useTranslation()
  const server = useServerStatus()
  const forced = useForcedOffline()
  const described = describe(server.state, t, forced)
  return { ...described, color: TONE_COLOR[described.tone] }
}

// The app shell handles this event from the sidebar, header and section links.
export function openSettings(section?: string): void {
  window.dispatchEvent(new CustomEvent('krobi-show-settings', { detail: { section } }))
}
