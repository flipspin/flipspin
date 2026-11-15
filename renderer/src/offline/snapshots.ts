import i18n from '../i18n'
import { connectionStore } from '../connection/connection'
import { isOfflineNow } from './policy'
import { bridge, hasBridge } from '../bridge'
import type { SnapshotKind } from '../lib/ipc'

export function snapshotKind(path: string): SnapshotKind | null {
  if (path === '/api/listar-albums-con-metadata') return 'listing'
  if (path === '/api/me/library') return 'library'
  if (path === '/api/playlists') return 'playlists'
  if (path === '/api/me/home') return 'home'
  if (/^\/api\/playlists\/[^/]+$/.test(path)) return `playlist:${decodeURIComponent(path.split('/').at(-1)!)}`
  return null
}
export async function snapshotResponse(path: string): Promise<{ ok: boolean; status: number; headers: Record<string, string>; body: string } | null> {
  const kind = snapshotKind(new URL(path, 'http://krobi.local').pathname)
  if (!hasBridge() || !kind) return null
  const state = connectionStore.getSnapshot()
  const connection = state.kind === 'ready' ? state.value?.connection.state : undefined
  if (connection === 'wrong-nest') return { ok: false, status: 503, headers: {}, body: JSON.stringify({ detail: 'wrong-nest' }) }
  // Playlist summaries must see changed album keys and newly available covers
  // on focus, even if the shell still has an older durable snapshot.
  if (kind === 'playlists' && connection !== 'connecting' && !isOfflineNow()) return null
  let row
  try { row = await bridge().invoke('offline:snapshot', { kind }) }
  catch (error) {
    if (!isOfflineNow() && connection !== 'connecting' && /account-required|nest-identity-required/.test(String(error))) return null
    throw error
  }
  const latest = connectionStore.getSnapshot()
  const current = latest.kind === 'ready' ? latest.value?.connection.state : undefined
  if (current === 'wrong-nest') return { ok: false, status: 503, headers: {}, body: JSON.stringify({ detail: 'wrong-nest' }) }
  if (kind === 'playlists' && current !== 'connecting' && !isOfflineNow()) return null
  // A local read must not win a race with the nest returning.
  if (connection === 'connecting' && current === 'connected' && !isOfflineNow()) return snapshotResponse(path)
  if (row === undefined && connection !== 'connecting') return null
  if (!row) return { ok: false, status: 503, headers: {}, body: JSON.stringify({ detail: 'snapshot-unavailable' }) }
  let body = row.body
  if (isOfflineNow() && (kind === 'library' || kind.startsWith('playlist:'))) {
    const pending = await bridge().invoke('offline:outbox', { action: 'list' })
    const view = JSON.parse(body) as { tracks: Record<string, unknown>[]; count?: number }
    for (const intent of pending ?? []) {
      if (intent.state !== 'queued') continue
      const change = JSON.parse(intent.body) as { name?: string; tracks?: Record<string, unknown>[]; relPaths?: string[] }
      if (kind.startsWith('playlist:') && intent.intent === 'playlist-edit' && kind === `playlist:${change.name}`) view.tracks = change.tracks ?? []
      if (kind === 'library' && change.relPaths) {
        const keys = new Set(change.relPaths)
        if (intent.intent === 'library-remove') view.tracks = view.tracks.filter(track => !keys.has(String(track.relPath)))
        if (intent.intent === 'library-add') for (const key of keys) {
          if (!view.tracks.some(track => track.relPath === key)) view.tracks.push({ relPath: key, addedAt: new Date(intent.createdAt * 1000).toISOString(), liked: false, offline: false, playCount: 0, lastPlayedAt: null })
        }
        view.count = view.tracks.length
      }
    }
    body = JSON.stringify(view)
  }
  return { ok: true, status: 200, headers: { etag: row.etag ?? '', ...((kind === 'playlists' || connection === 'connecting' || isOfflineNow()) ? { 'x-krobi-snapshot-at': String(row.fetchedAt) } : {}) }, body }
}

/** The shell owns durable intents; this is only the view and typed IPC adapter. */
export async function queueChange(intent: 'library-add' | 'library-remove' | 'playlist-edit', body: unknown) {
  return bridge().invoke('offline:outbox', { action: 'enqueue', id: crypto.randomUUID(), intent, body })
}

export async function offlineMutation(path: string, method: string, body: unknown) {
  if (!hasBridge() || !isOfflineNow() || method === 'GET') return null
  const pathname = new URL(path, 'http://krobi.local').pathname
  const data = typeof body === 'string' ? JSON.parse(body) as unknown : body
  if (pathname === '/api/me/library' && (method === 'POST' || method === 'DELETE')) {
    await queueChange(method === 'POST' ? 'library-add' : 'library-remove', data)
    const keys = (data as { relPaths: string[] }).relPaths
    return method === 'POST' ? { added: keys, already: [], missing: [], queued: true } : { removed: keys, queued: true }
  }
  const match = /^\/api\/playlists\/([^/]+)\/tracks$/.exec(pathname)
  if (match && method === 'PUT') {
    const name = decodeURIComponent(match[1])
    const row = await bridge().invoke('offline:snapshot', { kind: `playlist:${name}` })
    if (!row?.etag) throw new Error('playlist-version-required')
    await queueChange('playlist-edit', { name, tracks: data, etag: row.etag, base: JSON.parse(row.body) as unknown })
    return { success: true, queued: true }
  }
  throw new Error(i18n.t("This action requires the nest"))
}
