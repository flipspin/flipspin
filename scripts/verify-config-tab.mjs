// Real Vite app + Chromium. Only the HTTP boundary uses server-config fixtures.
// Run: node scripts/verify-config-tab.mjs
import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
const root = fileURLToPath(new URL('../', import.meta.url))
const out = `${root}internal/evidence/config-tab`
await mkdir(out, { recursive: true })
const server = await createServer({ configFile: `${root}renderer/vite.config.js`, server: { host: '127.0.0.1', port: 5188, strictPort: false } })
await server.listen()
const browser = await chromium.launch({ headless: true })
const base = JSON.parse(await readFile(`${root}contracts/wire/server-config.json`, 'utf8'))
base.machine.arch = 'x86_64'
base.machine.memoryBytes = 7.8e9
base.activity = { downloads: 2, jobs: 1, devicesSeen5min: 3 }
const fixture = {
  '/api/status': { app: 'krobi', version: '2.1.2', instanceId: 'config-fixture', name: 'Nido de prueba', isInit: true, setupDone: true, authMethods: ['token'] },
  '/api/me': { id: 'u1', label: 'Prueba', username: 'prueba', role: 'owner', isOwner: true, source: 'token' },
  '/api/get-basedir': { basedir: '/music' },
  '/api/listar-albums-con-metadata': [], '/api/playlists': [],
  '/api/library/summary': { folder: '/music', songs: 254, albums: 180, artists: 146 },
  '/api/server/storage': { disk: { total: 32e9, free: 29.6e9 }, music: 1.9e9, stems: 0.4e9, other: 0.1e9 },
  '/api/server/network': { lan: ['http://localhost:8000'], tailscale: null, externalUrl: null },
  '/api/providers': { providers: [] }, '/api/config/analysis-tags': { tags: [] },
  '/api/lyrics/jobs': { autoFetch: false, withLyrics: 200, pendingCount: 0, pending: [], running: null, queued: 0 },
  '/api/logs': { lines: [], total: 0, size: 0 },
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'es-MX', colorScheme: 'light' })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  let config = structuredClone(base)
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    if (path === '/api/server/config') {
      if (route.request().method() === 'PUT') {
        const { changes } = route.request().postDataJSON()
        for (const row of config.groups.flatMap(g => g.settings)) if (row.key in changes) {
          row.source = 'app'
          if (row.needsRestart) { row.pendingValue = changes[row.key]; config.restart.pending = [row.key] }
          else row.value = changes[row.key]
        }
      }
      return route.fulfill({ json: config, headers })
    }
    const json = fixture[path]
    return route.fulfill({ status: json ? 200 : 404, json: json ?? { detail: 'Not Found' }, headers })
  })
  await page.addInitScript(() => {
    localStorage.setItem('krobi.language', 'es')
    localStorage.setItem('theme', 'picnic')
    localStorage.setItem('krobi.mode', 'light')
    localStorage.setItem('krobi.web.credential', JSON.stringify({ token: 'fixture-only', userId: 'u1', label: 'Prueba', role: 'owner' }))
  })
  await page.goto(server.resolvedUrls.local[0])
  const open = async () => {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('krobi-show-settings', { detail: { section: 'config' } })))
    await page.getByRole('slider', { name: 'Descargas a la vez' }).waitFor()
    await page.evaluate(() => document.fonts.ready)
  }
  await page.getByRole('button', { name: 'Ajustes', exact: true }).waitFor()
  for (const [width, height, mode] of [[1440, 900, 'light'], [402, 874, 'dark']]) {
    config = structuredClone(base)
    await page.setViewportSize({ width, height })
    await page.evaluate(mode => { document.documentElement.dataset.mode = mode }, mode)
    await open()
    // Reopening retains the query cache; refetch when changing fixture scenario.
    await page.waitForTimeout(5200)
    const dialog = page.getByRole('dialog', { name: 'Ajustes', exact: true })
    assert.equal(await dialog.evaluate(el => el.scrollWidth > el.clientWidth), false)
    assert.equal(await page.locator('.aj-cap').evaluate(el => el.scrollWidth > el.clientWidth), false)
    const tag = `${mode}-${width}x${height}`
    await page.screenshot({ path: `${out}/section-${tag}.png` })
    await page.getByRole('combobox', { name: 'Motor de letras' }).selectOption('agent')
    await page.getByRole('button', { name: 'Reiniciar…', exact: true }).click()
    const restart = page.getByRole('dialog', { name: '¿Reiniciar el nido?' })
    await restart.waitFor()
    assert.equal(await restart.getByRole('radio', { name: 'Al terminar las descargas' }).getAttribute('aria-checked'), 'true')
    await page.screenshot({ path: `${out}/restart-dialog-${tag}.png` })
    await restart.getByRole('button', { name: 'Cancelar', exact: true }).click()
    // A setting pinned by the server's env file, shown in its actual card.
    const log = config.groups.flatMap(g => g.settings).find(r => r.key === 'KROBI_LOG_LEVEL')
    log.source = 'env'; log.editable = false
    await page.waitForTimeout(6200)
    const pinned = page.locator('[data-config-key="KROBI_LOG_LEVEL"]')
    await pinned.scrollIntoViewIfNeeded()
    assert.equal(await pinned.getByText('del servidor', { exact: true }).count(), 1)
    assert.equal(await pinned.getByRole('combobox').count(), 0)
    await page.screenshot({ path: `${out}/pinned-${tag}.png` })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    console.log(`PASS real app Chromium ${width}×${height} ${mode}: section, restart dialog (idle default), pinned row; no horizontal overflow.`)
  }
  assert.deepEqual(errors, [])
  console.log('PASS browser page errors: 0. Six screenshots saved under internal/evidence/config-tab/.')
} finally { await browser.close(); await server.close() }
