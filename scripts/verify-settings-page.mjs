// Real compiled renderer + Chromium; HTTP and native boundaries use fixtures.
// Run: node scripts/verify-settings-page.mjs
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import path from 'node:path'
import { chromium } from 'playwright'

const root = fileURLToPath(new URL('../', import.meta.url))
const withPlugin = process.env.KROBI_REVIEW_PLU124 === 'plugin'
const out = `${root}evidence/${withPlugin ? 'plugin-shots' : 'shots'}`
await mkdir(out, { recursive: true })
// No listening socket: the sandbox allows Chromium, but denies local servers.
// Compile the real renderer and intercept its static HTTP requests in Playwright.
// The verification-only transform installs the existing fake bridge seam after
// the native bootstrap, before any app module loads. No production source changes.
await build({
  configFile: `${root}renderer/vite.config.js`,
  build: { outDir: `${root}evidence/review-build`, emptyOutDir: true },
  plugins: [{ name: 'settings-review-bridge', enforce: 'pre', transform(code, id) {
    if (withPlugin && id.endsWith('/src/plugins/index.ts')) {
      return code.replace(/const modules = import.meta.glob[^\n]+/, `import reviewPlugin from '${root}scripts/fixtures/plu124-plugin.tsx'\nconst modules = { review: { default: reviewPlugin } }`)
    }
    if (!id.endsWith('/src/main.tsx')) return
    return code.replace('await installTauriBridge()', `await installTauriBridge()
const { setFakeBridgeForTest } = await import('./bridge')
setFakeBridgeForTest(globalThis.reviewBridge)
globalThis.__TAURI_INTERNALS__ = {}
const { openSettings } = await import('./shell/ServerBadge')
globalThis.reviewOpenSettings = openSettings`)
  } }],
})
const origin = 'http://krobi-review.test/'
const browser = await chromium.launch({ headless: true, args: ['--single-process', '--no-zygote', '--in-process-gpu'] })

const track = { title: 'Fixture song', artist: 'Fixture artist', album: 'Fixture album', path: '/music/Fixture/song.mp3', duration: 210 }
const me = { id: 'u1', label: 'Prueba', username: 'prueba', role: 'owner', isOwner: true, source: 'token', createdAt: '2026-08-02T10:00:00Z', lastSeenAt: null }
const fixture = {
  '/api/status': { app: 'krobi', version: '2.1.2', instanceId: 'page-verification', name: 'Nido de prueba', isInit: true, setupDone: true, authMethods: ['token'] },
  '/api/me': me,
  '/api/get-basedir': { basedir: '/music' },
  '/api/listar-albums-con-metadata': [],
  '/api/library/summary': { folder: '/music', songs: 254, albums: 180, artists: 146 },
  '/api/server/storage': { disk: { total: 32e9, free: 29.6e9 }, music: 1.9e9, stems: 0.4e9, other: 0.1e9 },
  '/api/users': { fixtureStatus: 404 },
  '/api/me/devices': { devices: [{ id: 'd1', label: 'Chromium de prueba', isCurrent: true }] },
  '/api/server/network': { lan: ['http://localhost:8000'], tailscale: null, externalUrl: null },
  '/api/providers': { providers: [] },
  '/api/config/analysis-tags': { tags: [] },
  '/api/playlists': [],
  '/api/lyrics/jobs': { autoFetch: false, withLyrics: 200, pendingCount: 14, pending: [], running: null, queued: 0, lastRun: null,
    engine: { mode: 'agent', queue: { queued: 14, leased: 0, online: false, agents: [] }, supported: false, installed: false, ready: false, hint: 'agent-needed', running: null, installing: null } },
  '/api/logs': { lines: [], total: 0, size: 0 },
}

const config = JSON.parse(await readFile(`${root}contracts/wire/server-config.json`, 'utf8'))
fixture['/api/server/config'] = config
fixture['/api/server/host'] = { hostname: 'nido', os: { name: 'Debian GNU/Linux', version: '12' }, kernel: '7.0.14-12', arch: 'x86_64', isolation: 'lxc', hypervisor: 'proxmox', cpu: { model: 'Intel Core i7-8750H', cores: 4 }, memory: { total: 4294967296, used: 122683392 }, python: '3.12.16', engine: 'agent', startedAt: '2026-11-08T12:00:00Z', bootedAt: '2026-10-20T12:00:00Z' }
fixture['/api/users'] = { users: [me, { id: 'u2', label: 'Luz', role: 'member', createdAt: '2026-09-12T10:00:00Z', lastSeenAt: '2026-11-06T12:00:00Z' }] }
for (const id of ['u1', 'u2']) fixture[`/api/users/${id}/devices`] = { devices: [{ id: 'd1', label: `iPhone de ${id === 'u1' ? 'Prueba' : 'Luz'}`, createdAt: null, lastSeenAt: '2026-11-07T12:00:00Z', isCurrent: id === 'u1' }, { id: 'd2', label: 'iPad del salón', lastSeenAt: null, createdAt: null, isCurrent: false }] }
fixture['/api/server/network'] = { lan: ['http://192.0.2.20:8000'], tailscale: { name: 'nido.tailnet.ts.net', ip: '100.64.0.20', url: 'http://100.64.0.20:8000' }, externalUrl: null, route: 'tailscale', outside: null }
fixture['/api/providers'] = { providers: [
  { id: 'deezer', name: 'Deezer', kind: 'metadata', capabilities: ['isrc', 'artwork'] },
  { id: 'musicbrainz', name: 'MusicBrainz', kind: 'metadata', capabilities: ['mbid'] },
  { id: 'spotify', name: 'Spotify', kind: 'metadata', requiresCredentials: true, capabilities: ['isrc'] },
  { id: 'lrclib', name: 'LRCLIB', kind: 'lyrics', capabilities: ['lyrics'] },
  { id: 'genius', name: 'Genius', kind: 'lyrics', requiresCredentials: true, capabilities: ['lyrics'] },
  { id: 'youtube', name: 'YouTube', kind: 'streaming', capabilities: ['stream'] },
].map((p, position) => ({ enabled: true, available: true, position, ...p })) }
fixture['/api/config/analysis-tags'] = { write_analysis_tags: false }
fixture['/api/lyrics/jobs'].engine.helpers = [
  { id: 'review-pc', name: 'Equipo de prueba', os: 'windows', accel: 'cuda', gpu: 'RTX 3060', chip: 'Intel Core i7', memoryBytes: 16 * 2 ** 30, jobs: ['align', 'transcribe', 'stems', 'analysis'], state: 'idle', lastSeenAt: Date.now() / 1000, nest: false },
]
fixture['/api/stems'] = { splits: [
  { album: 'Verificacion', file: 'melodia.wav', title: 'Melodía de prueba', artist: 'Prueba local', albumTitle: 'Verificación', createdAt: '2026-11-08T12:00:00Z', stale: false },
  { album: 'Verificacion', file: 'otra.wav', title: 'Otra melodía', artist: 'Prueba local', albumTitle: 'Verificación', createdAt: '2026-11-07T12:00:00Z', stale: false },
] }
fixture['/api/logs'] = { lines: ['2026-11-08 14:32:00 ERROR app.domains.downloads: Descarga de prueba sin conexión', '2026-11-08 14:31:00 WARNING app.domains.lyrics: Catálogo de prueba sin respuesta'], total: 2, sizeBytes: 184 }

const limits = { pace: 'fast', paused: false, window: null, onlyCharging: false, cpuPercent: 50, maxTempC: 85, resumeTempC: 75, use: {}, installEverything: false }
fixture['/api/compute/summary'] = {
  paused: false, waiting: 70,
  computers: [
    { id: 'helper1', name: 'MacBook Pro', nest: false, os: 'macos', accel: 'mlx', chip: 'Apple Silicon', memoryBytes: 16 * 2 ** 30, jobs: ['align', 'stems', 'analysis'], state: 'working', keepAwake: 'none', lastSeenAt: Date.now() / 1000, version: '0.14.1', blockedReasons: [], speed: { align: { samples: 5, medianSecondsPerMinute: 25 }, stems: { samples: 5, medianSecondsPerMinute: 7 }, analysis: { samples: 5, medianSecondsPerMinute: 1.2 } }, limits },
    { id: 'nest', name: 'The nest', nest: true, os: 'linux', accel: 'cpu', memoryBytes: 4 * 2 ** 30, jobs: ['analysis'], state: 'idle', keepAwake: 'none', lastSeenAt: Date.now() / 1000, version: '0.14.1', blockedReasons: [], speed: { analysis: { samples: 4, medianSecondsPerMinute: 6 } }, limits: { ...limits, pace: 'gentle', window: { days: [0, 1, 2, 3, 4, 5, 6], startMinute: 60, endMinute: 420 } } },
  ],
  kinds: ['align', 'stems', 'analysis'].map(kind => ({ kind, policy: { kind, placement: kind === 'analysis' ? 'anywhere' : 'helpers', paused: false, nestAfterS: 600, libraryPass: 'auto', requiredMemoryBytes: kind === 'analysis' ? 0 : 8 * 2 ** 30 }, waiting: kind === 'analysis' ? 70 : 0, oldestAt: null, failed: 0, running: kind === 'analysis' ? [{ workerId: 'helper1', title: 'Fixture song', progress: 91 }] : [], reason: null, waitingFor: 'MacBook Pro', nestMemoryBytes: 4 * 2 ** 30 })),
}
fixture['/api/analysis/summary'] = { total: 795, analyzed: 725, queued: 70, waiting: 70, failed: 0, engineVersion: 1, helper: { online: true, name: 'MacBook Pro', working: true }, estimated: { songs: 505, keys: 277, bpms: 348 }, run: { id: 'fixture-run', jobId: 'fixture-job', size: 795, done: 725, failed: 0, waiting: null, etaSeconds: 90 } }
fixture['/api/analysis/runs/preview'] = { size: 70, waiting: 70, outdated: 0, failed: 0, correctionsKept: 12, confirmationsKept: 4, skipped: [], estimateSeconds: 90 }
fixture['/api/jobs'] = { jobs: [{ id: 'sync-fixture', kind: 'lyrics-helper', label: 'Fixture song · Fixture artist', state: 'running', total: 4, succeeded: 1, failed: 0, skipped: 0, item: 'MacBook Pro', phase: 'alineando', percent: 25 }], degraded: [] }
fixture['/api/stems'].splits.forEach(split => { split.sizeBytes = 20_000_000 })

try {
  // Static evidence uses the app's reduced-motion path; rapid fixture navigation
  // otherwise races the shell's global View Transitions between screenshots.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US', colorScheme: 'light', reducedMotion: 'reduce' })
  page.setDefaultTimeout(15000)
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error) })
  await page.route('**/*', async route => {
    const pathname = new URL(route.request().url()).pathname
    const target = path.resolve(`${root}evidence/review-build`, pathname === '/' ? 'index.html' : `.${pathname}`)
    if (!target.startsWith(`${root}evidence/review-build/`)) return route.abort()
    try {
      const body = await readFile(target)
      const ext = path.extname(target)
      const contentType = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' }[ext] ?? 'application/octet-stream'
      await route.fulfill({ body, contentType })
    } catch { await route.fulfill({ status: 404, body: 'Not found' }) }
  })
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    if (path.endsWith('/cover.jpg')) return route.fulfill({ status: 404, headers })
    if (path === '/api/server/remote-route') fixture['/api/server/network'].route = route.request().postDataJSON().route
    const json = fixture[path]
    return route.fulfill({ status: json === undefined ? 404 : 200, json: json ?? { detail: 'Not Found' }, headers })
  })
  await page.addInitScript(({ track }) => {
    localStorage.setItem('krobi.language', 'en')
    localStorage.setItem('theme', 'picnic')
    localStorage.setItem('krobi.mode', 'light')
    localStorage.setItem('krobi.bottomBarDrawerOpen', '0')
    localStorage.setItem('krobi.web.credential', JSON.stringify({ token: 'fixture-only', userId: 'u1', label: 'Prueba', role: 'owner' }))
    localStorage.setItem('playerNowPlaying', JSON.stringify(track))
    localStorage.setItem('playerQueue', '[]')
  }, { track })
  await page.addInitScript(handshake => {
    const own = { id: 'helper1', name: 'MacBook Pro', os: 'macos', accel: 'mlx', chip: 'M1 Pro', macos: '26.1', memoryBytes: 16 * 2 ** 30, jobs: ['align', 'transcribe', 'stems', 'analysis'], state: 'idle', speed: { align: { samples: 3, medianSecondsPerMinute: 9 } }, version: '0.7.1', lastSeenAt: Date.now() / 1000, nest: false }
    globalThis.reviewBridge = { on: () => () => {}, invoke: async (channel, request) => {
      if (channel === 'server:get-status') return { mode: 'external', baseUrl: 'http://192.0.2.20:8000', reachable: true, identified: true, instanceId: handshake.instanceId, name: handshake.name, port: 8000, pid: null, adopted: false, starting: false, ownedByUs: false, problem: null, lanUrl: null, connection: { state: 'connected', since: Date.now(), attempt: 1, lastError: null, checks: [] } }
      if (channel === 'server:probe') return { ok: true, url: request.address, handshake }
      if (channel === 'app:get-backend-origin') return { origin: 'http://192.0.2.20:8000' }
      if (channel === 'app:get-version') return { version: '0.1.0' }
      if (channel === 'app:get-device-name') return { name: 'MacBook Pro' }
      if (channel === 'auth:get') return { hasToken: true, userId: 'u1', label: 'Prueba', role: 'owner' }
      if (channel === 'lyrics:worker-configure') return { ok: true }
      if (channel === 'lyrics:engine-status') {
        const state = globalThis.reviewEngineState ?? 'ready'
        const hardware = { ...own, memoryBytes: state === 'unavailable' ? 4 * 2 ** 30 : own.memoryBytes }
        return { enabled: state === 'ready' || state === 'installing', eligible: true, tray: true, workerId: own.id, hardware, worker: hardware, local: { id: own.id, state: 'idle', connected: state === 'ready' }, supported: true, installed: state === 'ready', agentRunning: state === 'ready', uv: true, engineReady: state === 'ready', addons: Object.fromEntries(['lyrics', 'stems', 'analysis'].map(target => [target, { installed: state === 'ready', ready: state === 'ready', sizeBytes: state === 'ready' ? target === 'lyrics' ? 1.2e9 : 82e6 : null }])), version: '0.7.1', sizeBytes: state === 'ready' ? 1.3e9 : null, installing: state === 'installing' ? { phase: 'paquetes', percent: 42 } : null }
      }
      if (channel === 'offline:status') return { tracks: [], usedBytes: 0, reservedBytes: 0, freeBytes: null, limitBytes: null, problems: [], revision: 0 }
      if (channel === 'offline:snapshot-get') return null
      if (channel === 'system:login-item-get') return { enabled: false, supported: true, status: 'disabled' }
      if (channel === 'log:write') return
      throw new Error(`Unexpected verification IPC: ${channel}`)
    } }
  }, fixture['/api/status'])
  await page.goto(origin)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.locator('.settings')
  await settings.waitFor()
  const open = async id => {
    await page.evaluate(id => window.reviewOpenSettings(id), id)
    await page.waitForFunction(id => document.querySelector('.settings')?.getAttribute('data-page') === id && document.querySelector('.settings-nav__item[aria-current="page"]'), id)
    await page.waitForFunction(() => !document.querySelector('.settings [aria-busy="true"]'))
    await page.evaluate(() => document.fonts.ready)
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => { document.documentElement.dataset.mode = theme }, theme)
    for (const id of ['complementos', 'letras', 'stems', 'analisis', 'equipos']) {
      await open(id)
      await settings.locator('.settings-main').evaluate(el => { el.scrollTop = 0 })
      assert.equal(await settings.evaluate(el => el.scrollWidth > el.clientWidth), false, `${id} horizontal overflow`)
      await page.screenshot({ animations: 'disabled', path: `${out}/${id}-${theme}-1440x900.png` })
      await settings.locator('.settings-main').evaluate(el => { el.scrollTop = el.scrollHeight })
      await page.screenshot({ animations: 'disabled', path: `${out}/${id}-${theme}-1440x900-bottom.png` })
      console.log(`PASS screenshot ${id} ${theme}; no horizontal overflow.`)
    }
  }
  await open('complementos')
  const cards = await settings.locator('.cx-card').evaluateAll(cards => cards.map(card => card.getAttribute('aria-label')))
  assert.deepEqual(cards.slice(0, 4), ['Engine', 'Lyrics', 'Stems', 'Analysis'])
  for (const [name, id] of [['Lyrics', 'letras'], ['Stems', 'stems'], ['Analysis', 'analisis']]) {
    await open('complementos')
    await settings.getByRole('region', { name, exact: true }).getByRole('button', { name: 'Open' }).click()
    await page.waitForFunction(id => document.querySelector('.settings')?.getAttribute('data-page') === id, id)
    assert.equal(await settings.locator('.settings-nav__item[aria-current="page"]').textContent(), 'Add-ons')
  }
  await open('equipos')
  assert.equal(await settings.getByText('Engines on this computer', { exact: true }).count(), 0)
  assert.equal(await settings.getByText('Ties', { exact: true }).count(), 0)
  assert.deepEqual(await settings.locator('.bw-panel').evaluateAll(panels => panels.map(panel => panel.getAttribute('aria-label'))), ['Computers', 'Where work runs'])
  for (const [legacy, id] of [['lyrics-settings', 'letras'], ['letras-nido', 'letras'], ['analysis', 'analisis'], ['extensiones', 'complementos']]) {
    await page.evaluate(raw => window.reviewOpenSettings(raw), legacy)
    await page.waitForFunction(id => document.querySelector('.settings')?.getAttribute('data-page') === id, id)
  }
  if (withPlugin) {
    const card = settings.getByRole('region', { name: 'Test add-on', exact: true })
    await card.getByRole('button', { name: 'Open' }).click()
    await card.getByText('Ajustes del complemento de prueba', { exact: true }).waitFor()
    await page.screenshot({ animations: 'disabled', path: `${out}/plugin-open-1440x900.png` })
  }
  assert.deepEqual(errors, [])
  console.log('PASS feature cards, merged Lyrics aliases, Helpers panels and no page errors.')
} finally {
  await browser.close()
}
