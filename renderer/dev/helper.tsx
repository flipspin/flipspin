/** Visual review entry: real Settings and bridge, synthetic input supplied by Playwright. */
import { createRoot } from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/inter/800.css'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import '@fontsource/geist-mono/700.css'
import '../src/index.css'
import '../src/ui/buttons.css'
import '../src/i18n'
import { setFakeBridgeForTest } from '../src/bridge'
import { DataProvider } from '../src/data'
import type { SchemaMacWorker } from '../src/api/generated/schema'
import type { KrobiBridge, MacEngineStatus, LoginItemState, AddonStatus } from '../src/lib/ipc'
import { SettingsPage } from '../src/settings/SettingsPage'

declare global {
  var __helperShot: { own: SchemaMacWorker; section: string; enabled: boolean; mode: string; gpu?: AddonStatus }
}
const { own, section, enabled, mode, gpu } = globalThis.__helperShot
const origin = 'http://helper-fixture.test'
document.documentElement.dataset.theme = 'paper'
document.documentElement.dataset.mode = mode
const status: MacEngineStatus = {
  engineReady: true, addons: { lyrics: { installed: true, ready: true, sizeBytes: null }, stems: { installed: true, ready: true, sizeBytes: null }, gpu },
  enabled, eligible: true, tray: true, workerId: own.id,
  hardware: { name: own.name, chip: own.chip ?? null, memoryBytes: own.memoryBytes, gpu: own.gpu ?? null, accel: own.accel, jobs: own.jobs },
  version: own.version, sizeBytes: null, local: { id: own.id, state: own.state, connected: enabled, lastError: null },
  worker: own, workerError: null, supported: true, installed: true, agentRunning: enabled,
  installing: null, installError: null, uv: true, workerSource: '', toolsDir: '', modelsDir: '',
}
let login: LoginItemState = { supported: true, enabled: own.os === 'macos', status: own.os === 'macos' ? 'enabled' : 'disabled' }
setFakeBridgeForTest({
  invoke: (async (channel: string, request: { enabled?: boolean; tray?: boolean } | undefined) => {
    if (channel === 'app:get-backend-origin') return { origin }
    if (channel === 'server:get-status') return { mode: 'external', baseUrl: origin, reachable: true, identified: true, starting: false, ownedByUs: false, adopted: false, problem: null, connection: { state: 'connected', since: 0, attempt: 1, lastError: null, checks: [] } }
    if (channel === 'server:probe') return { ok: true, url: origin, handshake: { app: 'krobi', version: '0.1.0', name: 'Nido de muestra', instanceId: 'helper-fixture', isInit: true, authMethods: ['token'] } }
    if (channel === 'offline:sync') return { ok: true }
    if (channel === 'offline:snapshot') return undefined
    if (channel === 'offline:mode') return { forced: false }
    if (channel === 'app:get-version') return { version: '0.1.0' }
    if (channel === 'app:get-device-name') return { name: own.name }
    if (channel === 'auth:get') return { hasToken: true, userId: 'ana', label: 'Ana', role: 'owner' }
    if (channel === 'lyrics:engine-status') return status
    if (channel === 'lyrics:worker-set') { status.enabled = request.enabled; return { ok: true } }
    if (channel === 'lyrics:worker-configure') { status.tray = request.tray; return { ok: true } }
    if (channel === 'system:login-item-get') return login
    if (channel === 'system:login-item-set') { login = { supported: true, enabled: request.enabled, status: request.enabled ? 'enabled' : 'disabled' }; return login }
    if (channel === 'log:write') return
    throw new Error(`Unexpected bridge channel: ${channel}`)
  }) as KrobiBridge['invoke'],
  on: () => () => {},
})
createRoot(document.getElementById('root')).render(<DataProvider><SettingsPage initialSection={section} surface="app" host={{ vlcIp: '', setVlcIp: () => {}, palette: 'paper', setPalette: () => {}, palettes: [], mode, setMode: () => {} }} /></DataProvider>)
