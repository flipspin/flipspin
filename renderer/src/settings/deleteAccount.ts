/** Flipspin's account deletion rules, shared with the mobile clients by contract. */
import i18n from '../i18n'
import type { ApiData } from '../data'
import { formatBytes, formatCount } from './format'

export type DeletionPreview = ApiData<'/api/users/{user_id}/deletion-preview', 'get'>
export type DeletionResult = ApiData<'/api/users/{user_id}', 'delete'>
export type DeleteChoice = 'account' | 'songs'

export function facts(preview: Pick<DeletionPreview, 'devices' | 'songs' | 'playlists'>): string {
  return [
    i18n.t("{{n}} devices", { count: preview.devices, n: formatCount(preview.devices) }),
    i18n.t("{{n}} songs", { count: preview.songs, n: formatCount(preview.songs) }),
    i18n.t('{{n}} playlists', { count: preview.playlists, n: formatCount(preview.playlists) }),
  ].join(' · ')
}

export function doLabel(choice: DeleteChoice, removable: number): string {
  return choice === 'account'
    ? i18n.t("Delete account")
    : i18n.t("Delete account and {{n}} songs", { count: removable, n: formatCount(removable) })
}

export function optionB(preview: DeletionPreview | null): { enabled: boolean; why: 'error' | 'none' | null } {
  if (preview === null) return { enabled: false, why: 'error' }
  return preview.removable.count > 0 ? { enabled: true, why: null } : { enabled: false, why: 'none' }
}

export function toast(name: string, result: Pick<DeletionResult, 'removedSongs' | 'freedBytes'>): string {
  const account = i18n.t("{{name}}’s account deleted", { name })
  return result.removedSongs > 0
    ? `${account} · ${i18n.t("{{n}} songs deleted · {{size}} freed", {
      count: result.removedSongs, n: formatCount(result.removedSongs), size: formatBytes(result.freedBytes),
    })}`
    : account
}
