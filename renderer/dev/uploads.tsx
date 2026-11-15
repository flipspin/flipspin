/** Real sheet and toolbar with deterministic native bridge fixtures. */
import React, { useRef } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '../src/ui/tokens/app.css'
import '../src/ui/overlay.css'
import '../src/ui/primitives.css'
import '../src/index.css'
import '../src/ui/buttons.css'
import '../src/i18n'
import { UploadHost } from '../src/uploads/UploadHost'
import { openUpload } from '../src/uploads/actions'
import { DataProvider } from '../src/data'
import { setFakeBridgeForTest } from '../src/bridge'
import type { KrobiBridge, UploadBatch, UploadItem } from '../src/lib/ipc'
import LibraryToolbar from '../src/albums/LibraryToolbar'
import { useLibraryView } from '../src/albums/hooks/useLibraryView'

const phase = new URLSearchParams(location.search).get('phase') ?? 'resumen'
document.documentElement.dataset.mode = new URLSearchParams(location.search).get('mode') ?? 'light'
document.documentElement.dataset.theme = 'paper'
const base: UploadItem = { id: '1', sha256: '1', name: 'Radiohead/OK Computer/04 Exit Music (For a Film).mp3', bytes: 26_000_000, offset: 0, state: 'por-subir', reason: null, duplicate: false }
const files: UploadItem[] = Array.from({ length: 1003 }, (_, i) => ({ ...base, id: String(i), sha256: String(i), state: i < 812 ? 'ya-estaba' : i < 1000 ? 'por-subir' : 'no-apta', reason: i < 1000 ? null : 'no-es-audio', duplicate: i >= 812 && i < 819, already: i < 812 }))
if (phase === 'subiendo' || phase === 'terminado') files.forEach((f, i) => {
  if (i >= 812 && i < (phase === 'terminado' ? 996 : 853)) { f.state = 'agregada'; f.offset = f.bytes }
})
if (phase === 'terminado') {
  files.filter(f => f.state === 'ya-estaba').forEach(f => { f.state = 'agregada'; f.offset = f.bytes })
  files[996] = { ...files[996], state: 'fallida', reason: 'fallo-subida', name: 'Radiohead/OK Computer/02 Paranoid Android.mp3' }
  files[997] = { ...files[997], state: 'no-apta', reason: 'archivo-danado', name: 'Björk/Homogenic/07 Bachelorette.flac' }
  files[998] = { ...files[998], state: 'no-apta', reason: 'muy-grande', name: 'Live/Concierto completo 2019.wav' }
  files[999] = { ...files[999], state: 'fallida', reason: 'sin-espacio', name: 'Varios/voz memo 2014.m4a' }
}
const batch: UploadBatch = { id: 'fixture', phase: phase === 'elegir' ? 'resumen' : phase as UploadBatch['phase'], files, reviewed: 412, total: 1003, maxBytes: 500_000_000, current: base.name }
const listeners = new Map<string, (value: unknown) => void>()
const server = { mode: 'remote', reachable: true, instanceId: 'fixture', connection: { state: 'connected', since: 0, attempt: 0, checks: [], lastError: null } }
setFakeBridgeForTest({
  invoke: (async (channel, request) => {
    if (channel === 'server:get-status') return server
    if (channel === 'upload:status') return { batches: phase === 'elegir' ? [] : [batch] }
    if (channel === 'upload:start') { listeners.get('upload:changed')?.({ ...batch, phase: 'subiendo' }); return { ...batch, phase: 'subiendo' } }
    if (channel === 'upload:stop') return { ...batch, phase: 'terminado' }
    if (channel === 'upload:retry-failed') return { ...batch, phase: 'subiendo' }
    if (channel === 'app:get-backend-origin') return { origin: location.origin }
    if (channel === 'auth:get') return { userId: 'ana', label: 'Ana', role: 'owner', hasToken: true }
    return request ?? null
  }) as KrobiBridge['invoke'],
  on: ((channel, listener) => { listeners.set(channel, listener as (value: unknown) => void); return () => { listeners.delete(channel) } }) as KrobiBridge['on'],
})
const albums = [{ album: 'OK Computer', artist: 'Radiohead', path: 'OK Computer', tracks: ['Airbag', 'Paranoid Android', 'Subterranean Homesick Alien', 'Exit Music (For a Film)', 'Let Down'].map((title, i) => ({ path: `OK Computer/${i}.mp3`, title, artist: 'Radiohead', duration: 240 })) }]
const noop = () => {}
// eslint-disable-next-line react-refresh/only-export-components
function Harness() {
  const view = useLibraryView(albums)
  // A finished batch is reopened from its Jobs row; the harness does the same.
  React.useEffect(() => { if (phase === 'terminado') setTimeout(() => openUpload('fixture'), 0) }, [])
  const searchRef = useRef<HTMLInputElement>(null)
  return <main style={{ minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)', padding: '40px 56px' }}>
    <UploadHost /><h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 24 }}>Biblioteca</h1>
    <DataProvider><LibraryToolbar view={view} searchRef={searchRef} scoped canScope onScope={noop} serverCount={714} mineCount={5} accountName="Ana" reloading={false} onReload={noop} /></DataProvider>
    <table style={{ width: '100%', marginTop: 24, textAlign: 'left', fontSize: 14 }}><thead><tr><th>Título</th><th>Artista</th><th>Álbum</th></tr></thead><tbody>{albums[0].tracks.map(track => <tr key={track.path} style={{ height: 52, borderBottom: '1px solid var(--line-soft)' }}><td>{track.title}</td><td>{track.artist}</td><td>OK Computer</td></tr>)}</tbody></table>
  </main>
}
createRoot(document.getElementById('root')!).render(<DataProvider><Harness /></DataProvider>)
