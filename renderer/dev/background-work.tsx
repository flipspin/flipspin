/** Visual review entry: real settings components; synthetic machine and HTTP boundary. */
import { createRoot } from 'react-dom/client'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/geist-mono/400.css'
import '../src/index.css'
import '../src/ui/buttons.css'
import '../src/i18n'
import { setFakeBridgeForTest } from '../src/bridge'
import { DataProvider } from '../src/data'
import { SettingsPage } from '../src/settings/SettingsPage'
import type { KrobiBridge, MacEngineStatus } from '../src/lib/ipc'
const origin = 'http://compute-fixture.test'
const params = new URLSearchParams(location.search)
const mode = params.get('mode') ?? 'light'
document.documentElement.dataset.theme = 'paper'
document.documentElement.dataset.mode = mode
const status: MacEngineStatus = {
  engineReady: true, addons: { lyrics: { installed: false, ready: false, sizeBytes: null }, stems: { installed: true, ready: true, sizeBytes: 100_000_000 }, analysis: { installed: true, ready: true, sizeBytes: 80_000_000 }, gpu: { installed: true, ready: true, sizeBytes: null, included: true } },
  enabled: true, eligible: true, tray: false, workerId: 'helper', hardware: { name: 'Helper computer', chip: 'Apple Silicon', memoryBytes: 16 * 2 ** 30, gpu: null, accel: 'mlx', jobs: ['align', 'stems', 'analysis'] },
  version: '0.14.1', sizeBytes: 1_300_000_000, local: { id: 'helper', state: 'idle', connected: true, lastError: null }, worker: null, workerError: null, supported: true, installed: true, agentRunning: true,
  installing: null, installError: null, uv: true, workerSource: '', toolsDir: '', modelsDir: '',
}
if (params.get('state') === 'installing') status.installing = { target: 'analysis', phase: 'modelos', percent: 62 }
if (params.get('state') === 'error') status.addons.lyrics.error = 'No space left on device'
setFakeBridgeForTest({
  invoke: (async (channel: string) => {
    if (channel === 'app:get-backend-origin') return { origin }
    if (channel === 'server:get-status') return { mode: 'external', baseUrl: origin, reachable: true, identified: true, starting: false, ownedByUs: false, adopted: false, problem: null, connection: { state: 'connected', since: 0, attempt: 1, lastError: null, checks: [] } }
    if (channel === 'offline:mode') return { forced: false }
    if (channel === 'offline:sync') return { ok: true }
    if (channel === 'offline:snapshot') return undefined
    if (channel === 'app:get-version') return { version: '0.1.0' }
    if (channel === 'app:get-device-name') return { name: 'Helper computer' }
    if (channel === 'auth:get') return { hasToken: true, userId: 'owner', label: 'Owner', role: 'owner' }
    if (channel === 'lyrics:engine-status') return status
    if (channel === 'log:write') return
    return { ok: true }
  }) as KrobiBridge['invoke'], on: () => () => {},
})
createRoot(document.getElementById('root')!).render(<DataProvider><SettingsPage initialSection={params.get('section') ?? 'equipos'} surface="app" host={{ vlcIp: '', setVlcIp: () => {}, palette: 'paper', setPalette: () => {}, palettes: [], mode, setMode: () => {} }} /></DataProvider>)
