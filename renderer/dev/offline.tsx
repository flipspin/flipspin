/** Real app, synthetic shell/disk boundary. Used only by the evidence harness. */
import { createRoot } from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/800.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/700.css'
import '../src/index.css'
import '../src/ui/buttons.css'
import '../src/i18n'
import App from '../src/shell/App'
import { DataProvider } from '../src/data'
import { setFakeBridgeForTest } from '../src/bridge'
import type { KrobiBridge, SnapshotKind } from '../src/lib/ipc'

declare global { var __offlineShot: { mode: string; forced: boolean } }
const at = Date.parse('2026-11-09T18:42:00-06:00') / 1000
const names = ['Silk Threshold', 'Ceramic Steps', 'Paper Kite', 'A Thread of Amber', 'Lighthouses Out', 'Prism Dust', 'Cricket Road', 'The Folded Echo', 'Two Close Tones', 'Sepia Epilogue', 'Origami Coda', 'Period Doubling']
const artists = ['Nebula Workshop', 'Hexagon Haze', 'Ember Orchestra', 'Prism Nine Trio', 'Ember Orchestra', 'Saffron Circle']
const albums = [{ album: 'Paper Sessions', artist: 'Nebula Workshop', path: '/music/Paper Sessions', mediaKey: 'Paper Sessions', cover: null, tracks: names.map((title, i) => ({ title, artist: artists[i % artists.length], path: `/music/Paper Sessions/${i}.mp3`, relPath: `Paper Sessions/${i}.mp3`, url_path: `/api/media/Paper Sessions/${i}.mp3`, duration: 214 + i * 11, track_number: i + 1, dateAdded: 1794250000 })) }]
const library = { count: 12, tracks: albums[0].tracks.map(track => ({ relPath: track.relPath, addedAt: '2026-11-01T10:00:00Z', playCount: 0, liked: false, offline: false, lastPlayedAt: null })) }
const snapshots = { listing: albums, library, playlists: [], home: { albums, library, playlists: [] } }
const events = new Map<string, Set<(value: unknown) => void>>()
const status = { mode: 'external', baseUrl: 'http://nido-de-la-sala.test', instanceId: 'fixture-nido', reachable: false, identified: true, starting: false, ownedByUs: false, adopted: false, problem: null, connection: { state: 'unreachable', since: 1794261600000, attempt: 3, lastError: 'timeout', checks: [] } }
let forced = globalThis.__offlineShot.forced
setFakeBridgeForTest({
  invoke: (async (channel: string, request?: { kind?: SnapshotKind; forced?: boolean; keys?: string[] }) => {
    if (channel === 'app:get-backend-origin') return { origin: 'http://localhost:8000' }
    if (channel === 'server:get-status') return status
    if (channel === 'offline:mode') { if (request?.forced !== undefined) forced = request.forced; return { forced } }
    if (channel === 'offline:snapshot') return { kind: request.kind, body: JSON.stringify(snapshots[request.kind]), fetchedAt: at, etag: '"fixture"' }
    if (channel === 'offline:outbox') return [1, 2].map(id => ({ id: String(id), idempotencyKey: String(id), intent: 'library-add', body: '{"relPaths":[]}', createdAt: at, attempts: 0, lastError: null, state: 'queued' }))
    if (channel === 'offline:status') return { pins: 7, files: 7, bytes: 28000000, tracks: (request.keys ?? []).map((key, i) => ({ key, state: i % 3 === 2 ? 'no descargado' : 'descargado', verifiedAt: i % 3 === 2 ? null : at, pool: i % 3 === 2 ? null : 'offline', bytes: i % 3 === 2 ? 0 : 4000000, etag: null, lastPlayedAt: null, error: null })) }
    if (channel === 'auth:get') return { hasToken: true, userId: 'fixture-user', label: 'nicopw', role: 'owner' }
    if (channel === 'app:get-version') return { version: '0.1.0' }
    if (channel === 'app:get-device-name') return { name: 'Equipo de muestra' }
    if (channel === 'lyrics:worker-configure') return { ok: true }
    if (channel === 'log:write') return
    throw new Error(`Unexpected fixture IPC: ${channel}`)
  }) as KrobiBridge['invoke'],
  on: ((channel: string, fn: (value: unknown) => void) => { const set = events.get(channel) ?? new Set(); events.set(channel, set); set.add(fn); return () => set.delete(fn) }) as KrobiBridge['on'],
})
createRoot(document.getElementById('root')!).render(<DataProvider><App /></DataProvider>)
