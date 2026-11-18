/** Narrow import responses here so parsing stays out of components.
 * Register returned progress ids with the downloads store; imports run in the background. */

import { apiPost } from '../data'

/** What a started job tells the caller. */
export interface StartedJob {
  progressId: string
  /** The server's own count when it knows it, else what the caller expected. */
  total: number
}

/** A playlist as the preview shows it, before anything is downloaded. */
export interface PlaylistPreview {
  name: string
  coverUrl: string | null
  trackCount: number
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * A body with no `progress_id` is a failure even on a 200. These routes
 * answer 200 with an error payload in some paths, and treating that as a start
 * would put a job in the panel that no stream will ever report on.
 */
function startedJob(body: unknown, fallbackTotal: number): StartedJob {
  const id = text(record(body)?.progress_id)
  if (id === null) throw new Error('missing progress_id')
  return { progressId: id, total: count(record(body)?.total) ?? fallbackTotal }
}

/** `POST /api/fetch-spotify-playlist`; read it, download nothing. */
export async function previewPlaylist(url: string): Promise<PlaylistPreview> {
  const body = await apiPost('/api/fetch-spotify-playlist', { body: { playlist_url: url } })
  const data = record(body)
  const tracks = data?.tracks
  return {
    name: text(data?.name) ?? 'Playlist',
    coverUrl: text(data?.cover_url),
    trackCount: Array.isArray(tracks) ? tracks.length : 0,
  }
}

/** Send processing options explicitly so server default changes cannot silently alter imports. */
const PROCESSING = { normalize: false, effect_type: 'clean', volume_boost: 4 } as const

/** `POST /api/import-playlist-url`; the whole playlist, in the background. */
export async function importPlaylist(url: string, expected: number): Promise<StartedJob> {
  // `selected_indices` is deliberately omitted. Sent as an empty array it
  // means "none of them", and the backend's own default for the missing field
  // is "all of them"; which is what pasting a link and pressing import means.
  const body = await apiPost('/api/import-playlist-url', {
    body: { playlist_url: url, ...PROCESSING },
  })
  return startedJob(body, expected)
}

/** This route finishes synchronously and returns no progress id; report completion directly. */
export async function downloadFromYoutube(url: string, name: string | null): Promise<string[]> {
  const body = await apiPost('/api/download-youtube-url', {
    body: {
      url,
      ...PROCESSING,
      // The backend appends the extension; a name typed with ".mp3" would
      // otherwise land on disk as "cancion.mp3.mp3".
      ...(name ? { filename: name.replace(/\.mp3$/i, '') } : {}),
    },
  })
  const data = record(body)
  const ok = data?.success === true || data?.status === 'success'
  if (!ok) throw new Error('youtube download refused')
  const files = data?.files
  return Array.isArray(files) ? files.filter((file): file is string => typeof file === 'string') : []
}
