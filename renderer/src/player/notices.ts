import i18n from '../i18n'
import { bridge, hasBridge } from '../bridge'
import { notify } from '../ui/notifications'
import type { PlayerNotice } from './PlaybackController'
import type { FailureCause } from './playerState'

export function failureReason(cause: FailureCause | null): string {
  const t = i18n.t.bind(i18n)
  switch (cause) {
    case 'auth': return t("Your session expired")
    case 'decode': return t("Damaged file")
    case 'missing': return t("File not found")
    case 'notSupported': return t("Unsupported format")
    default: return t("Could not connect to the nest")
  }
}

export function playbackNotice(notice: PlayerNotice, title: string) {
  const t = i18n.t.bind(i18n)
  switch (notice) {
    case 'gesture': notify({ id: 'player-gesture', message: t("Tap play to continue") }); break
    case 'auth':
      notify({ id: 'player-auth', level: 'error', message: t("Your session expired"), action: {
        label: t("Sign in_imperative"), onSelect: () => { if (hasBridge()) void bridge().invoke('server:report-auth', { status: 401 }).catch(() => {}) },
      } }); break
    case 'deleted': notify({ message: t("This song was deleted from Nido") }); break
    case 'empty': notify({ message: t("No playable songs left in the queue") }); break
    case 'consecutive': notify({ level: 'warning', message: t("Several songs could not be played") }); break
    case 'decode': notify({ level: 'warning', message: t("Skipped: {{title}} (damaged file)", { title }) }); break
    case 'missing': notify({ level: 'warning', message: t("Skipped: {{title}} (file not found)", { title }) }); break
    case 'notSupported': notify({ level: 'warning', message: t("Skipped: {{title}} (unsupported format)", { title }) }); break
  }
}
