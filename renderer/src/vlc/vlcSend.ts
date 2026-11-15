/** Save the VLC address only after a successful send and reopen the editor on failure.
 * Keep this store outside React because song menus share one shell-mounted send card. */
import { useSyncExternalStore } from 'react'

import i18n from '../i18n'
import { apiPost } from '../data'

export interface VlcSong {
  path: string
}

export type VlcCard =
  | { kind: 'closed' }
  /** Asking for the address; `failedAt` when the last try did not answer. */
  | { kind: 'ask'; songs: VlcSong[]; address: string; failedAt: string | null; sending: boolean }

export interface VlcState {
  card: VlcCard
  /** The last outcome, for the toast; a number that changes each time. */
  done: { sent: number; failed: number; at: number } | null
}

let state: VlcState = { card: { kind: 'closed' }, done: null }
const listeners = new Set<() => void>()
let saveAddress: ((ip: string) => void) | null = null

function emit(next: Partial<VlcState>): void {
  state = { ...state, ...next }
  listeners.forEach((listener) => listener())
}

/** The shell registers how a working address is stored. */
export function registerVlcAddressStore(save: (ip: string) => void): () => void {
  saveAddress = save
  return () => {
    if (saveAddress === save) saveAddress = null
  }
}

export function useVlcState(): VlcState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
    () => state,
  )
}

export function openVlcCard(songs: VlcSong[], address = ''): void {
  emit({ card: { kind: 'ask', songs, address, failedAt: null, sending: false } })
}

export function closeVlcCard(): void {
  emit({ card: { kind: 'closed' } })
}

export function setCardAddress(address: string): void {
  if (state.card.kind === 'ask') emit({ card: { ...state.card, address } })
}

/** `POST /api/upload-selected-vlc`. Resolves to how many VLC refused. */
async function upload(songs: VlcSong[], ip: string): Promise<number> {
  const body = await apiPost('/api/upload-selected-vlc', { body: { paths: songs.map((s) => s.path), vlc_ip: ip } })
  const record = (typeof body === 'object' && body !== null ? body : {}) as { status?: unknown; failed?: unknown }
  if (String(record.status ?? '').toLowerCase() === 'error') throw new Error('vlc refused')
  return Array.isArray(record.failed) ? record.failed.length : 0
}

/**
 * Send to an address. On success the address is saved and the card closes; on
 * failure the card (re)opens with "Sin respuesta en <ip>".
 */
export async function sendToVlc(songs: VlcSong[], ip: string): Promise<boolean> {
  const address = ip.trim()
  if (songs.length === 0 || address === '') return false
  if (state.card.kind === 'ask') emit({ card: { ...state.card, address, sending: true, failedAt: null } })
  try {
    const failed = await upload(songs, address)
    saveAddress?.(address)
    emit({ card: { kind: 'closed' }, done: { sent: songs.length - failed, failed, at: Date.now() } })
    return true
  } catch {
    emit({ card: { kind: 'ask', songs, address, failedAt: address, sending: false } })
    return false
  }
}

export interface VlcMenuItem {
  label: string
  color?: string
  hint?: string
  onClick: () => void
}

/**
 * The "Send to" submenu for these songs. Shaped like the track menu's own
 * items so every host passes it straight through.
 */
export function vlcMenuItems(songs: VlcSong[], savedIp: string): VlcMenuItem[] {
  const ip = savedIp.trim()
  if (ip === '') return [{ label: i18n.t('VLC…'), color: 'var(--coral)', onClick: () => openVlcCard(songs) }]
  return [
    { label: i18n.t('VLC · {{ip}}', { ip }), color: 'var(--coral)', onClick: () => void sendToVlc(songs, ip) },
    { label: i18n.t("Change VLC address…"), color: 'var(--ink-3)', onClick: () => openVlcCard(songs, ip) },
  ]
}

export function resetVlcForTest(): void {
  state = { card: { kind: 'closed' }, done: null }
  saveAddress = null
}
