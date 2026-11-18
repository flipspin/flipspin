// Real Vite app + Chromium. Only the HTTP boundary uses server-config fixtures.
// Run: node scripts/verify-krobi-ui.mjs before|after
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { chromium } from 'playwright'
const workspace = fileURLToPath(new URL('../', import.meta.url))
// A detached original checkout can supply the baseline after the extraction.
const root = process.env.KROBI_UI_SOURCE_ROOT ?? workspace
const phase = process.argv[2]
assert(['before', 'after'].includes(phase), 'Usage: node scripts/verify-krobi-ui.mjs before|after')
const out = `${workspace}internal/evidence/krobi-ui/${phase}`
await mkdir(out, { recursive: true })
const server = await createServer({ configFile: `${root}renderer/vite.config.js`, cacheDir: `${root}.krobi-dev/ui-verify-cache`, server: { host: '127.0.0.1', port: 5188, strictPort: false } })
await server.listen()
const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] })
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
// Same real-app HTTP fixtures and navigation as verify-config-tab.mjs and
// verify-settings-page.mjs; welcome navigation follows verify-first-run.mjs.
const errors = []
async function capture(name, { claimed = true, signedIn = false, section } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'es-MX', colorScheme: 'light', reducedMotion: 'reduce' })
  const page = await context.newPage()
  // Freeze dates and random input, not app timers. The shell's Ising canvas
  // otherwise changes independently of UI styles, even with reduced motion.
  await page.clock.setFixedTime(new Date('2026-10-28T18:00:00Z'))
  await page.addInitScript(() => { Math.random = () => 0.5 })
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname
    if (!path.startsWith('/api/')) return route.continue()
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    const json = path === '/api/status' ? { ...fixture[path], isInit: claimed, setupDone: claimed }
      : path === '/api/server/config' ? base : fixture[path]
    return route.fulfill({ status: json ? 200 : 404, json: json ?? { detail: 'Not Found' }, headers })
  })
  await page.addInitScript(signedIn => {
    localStorage.setItem('krobi.language', 'es')
    localStorage.setItem('theme', 'picnic')
    localStorage.setItem('krobi.mode', 'light')
    if (signedIn) localStorage.setItem('krobi.web.credential', JSON.stringify({ token: 'fixture-only', userId: 'u1', label: 'Prueba', role: 'owner' }))
  }, signedIn)
  await page.goto(server.resolvedUrls.local[0])
  if (section) {
    await page.getByRole('button', { name: 'Ajustes', exact: true }).click()
    if (section === 'config') {
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('krobi-show-settings', { detail: { section: 'config' } })))
      await page.getByRole('slider', { name: 'Descargas a la vez' }).waitFor()
    } else {
      await page.getByRole('heading', { name: 'Resumen', exact: true }).waitFor()
      await page.getByText('254 canciones', { exact: true }).waitFor()
    }
  } else {
    await page.getByRole('heading', { name: claimed ? 'Inicia sesión' : 'Configuración de KROBI', exact: true }).waitFor()
  }
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(500)
  await page.mouse.move(0, 0)
  const shot = await page.screenshot({ animations: 'disabled', path: `${out}/${name}-1440x900.png` })
  // Record every rendered element's computed styles too, for colours, geometry,
  // pseudo-elements and controls beyond the screenshot's visible pixels.
  const styles = await page.evaluate(() => [...document.querySelectorAll('body *')].map(el => {
    const snapshot = pseudo => {
      const style = getComputedStyle(el, pseudo)
      return Object.fromEntries([...style].filter(p => !p.startsWith('--')).map(p => [p, style.getPropertyValue(p)]))
    }
    return { tag: el.tagName, class: el.getAttribute('class'), styles: snapshot(null), before: snapshot('::before'), after: snapshot('::after') }
  }))
  await writeFile(`${out}/${name}-styles.json`, JSON.stringify(styles))
  console.log(`PASS ${phase} ${name}: Chromium 1440×900; ${shot.length} screenshot bytes`)
  await context.close()
}
try {
  await capture('wizard-welcome', { claimed: false })
  await capture('ajustes-resumen', { signedIn: true, section: 'resumen' })
  await capture('configuracion', { signedIn: true, section: 'config' })
  await capture('sign-in')
  assert.deepEqual(errors, [])
  console.log('PASS browser page errors: 0')
  if (phase === 'after') {
    for (const name of ['wizard-welcome', 'ajustes-resumen', 'configuracion', 'sign-in']) {
      const before = await readFile(`${out}/../before/${name}-1440x900.png`)
      const after = await readFile(`${out}/${name}-1440x900.png`)
      assert(before.equals(after), `${name}: screenshot differs`)
      const beforeStyles = JSON.parse(await readFile(`${out}/../before/${name}-styles.json`, 'utf8'))
      const afterStyles = JSON.parse(await readFile(`${out}/${name}-styles.json`, 'utf8'))
      assert.deepEqual(afterStyles, beforeStyles, `${name}: computed styles differ`)
      console.log(`PASS ${name}: byte-identical PNG; all rendered computed styles identical`)
    }
  }
} finally { await browser.close(); await server.close() }
