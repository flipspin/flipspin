import { useSyncExternalStore } from 'react'
import type { components } from '../api/generated/schema'

/** Auto = album gain for an album played in order, track gain otherwise. Track and Album are forced. */
export type VolumeLevelling = 'off' | 'auto' | 'track' | 'album'
const KEY = 'krobi.volumeLevelling'
const EVENT = 'krobi-volume-levelling'

export function getVolumeLevelling(): VolumeLevelling {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'off' || value === 'track' || value === 'album' ? value : 'auto'
  } catch { return 'auto' }
}

export function setVolumeLevelling(value: VolumeLevelling): void {
  localStorage.setItem(KEY, value)
  window.dispatchEvent(new Event(EVENT))
}

function subscribe(change: () => void): () => void {
  window.addEventListener(EVENT, change)
  window.addEventListener('storage', change)
  return () => { window.removeEventListener(EVENT, change); window.removeEventListener('storage', change) }
}

export function useVolumeLevelling(): VolumeLevelling {
  return useSyncExternalStore(subscribe, getVolumeLevelling, () => 'auto')
}

export type ReplayGain = Partial<components['schemas']['ReplayGain']>

export function gainMultiplier(gain: ReplayGain | null | undefined, mode: VolumeLevelling, albumOrder: boolean): number {
  if (!gain || mode === 'off') return 1
  const album = (mode === 'album' || (mode === 'auto' && albumOrder)) && Number.isFinite(gain.albumGain)
  const db = album ? gain.albumGain : gain.trackGain
  if (typeof db !== 'number' || !Number.isFinite(db)) return 1
  const peak = album ? gain.albumPeak ?? gain.trackPeak : gain.trackPeak
  const factor = 10 ** (Math.max(-60, Math.min(60, db)) / 20)
  // Preserve relative album dynamics while preventing a measured peak from clipping.
  return typeof peak === 'number' && Number.isFinite(peak) && peak > 0 ? Math.min(factor, 1 / peak) : factor
}

export function albumKey(track: { relPath?: unknown; path?: unknown; album?: unknown } | null): string | null {
  if (typeof track?.relPath === 'string') return track.relPath.split('/')[0] || null
  if (track?.album && typeof track.album === 'object' && 'path' in track.album && typeof track.album.path === 'string') return track.album.path
  return typeof track?.path === 'string' ? track.path.slice(0, track.path.lastIndexOf('/')) || null : null
}

export function orderedAlbum(tracks: (NonNullable<Parameters<typeof albumKey>[0]> & { track_number?: unknown; discNumber?: unknown; disc_number?: unknown })[]): string | null {
  const key = albumKey(tracks[0] ?? null)
  if (!tracks.length || !key || !tracks.every(track => albumKey(track) === key)) return null
  for (let index = 1; index < tracks.length; index++) {
    const previous = tracks[index - 1]
    const current = tracks[index]
    const previousDisc = Number(previous.discNumber ?? previous.disc_number ?? 1)
    const currentDisc = Number(current.discNumber ?? current.disc_number ?? 1)
    if (currentDisc < previousDisc) return null
    if (currentDisc === previousDisc && typeof previous.track_number === 'number' && typeof current.track_number === 'number' && current.track_number <= previous.track_number) return null
  }
  return key
}
