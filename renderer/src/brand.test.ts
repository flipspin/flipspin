import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { APP_NAME, SERVER_IMAGE } from './brand'
import { BRIDGE_KEY } from './lib/ipc'
import en from '../locales/en/translation.json'
import es from '../locales/es/translation.json'

const root = resolve(import.meta.dirname, '../..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

it('ships Flipspin to people while retaining the bridge and discovery protocol', () => {
  expect(APP_NAME).toBe('Flipspin')
  const config: { productName: string; identifier: string; app: { windows: { title: string }[] } } = JSON.parse(read('src-tauri/tauri.conf.json'))
  expect(config.productName).toBe(APP_NAME)
  expect(config.identifier).toBe('app.flipspin.desktop')
  expect(config.app.windows[0].title).toBe(APP_NAME)
  expect(read('renderer/index.html')).toContain('<title>Flipspin</title>')
  expect(BRIDGE_KEY).toBe('krobi')
  expect(read('src-tauri/Info.plist')).toContain('<string>_krobi._tcp</string>')
  expect(read('src-tauri/src/desktop/handshake.rs')).toContain('Some("krobi")')
  expect(read('src-tauri/src/lyrics/runtime.rs')).toContain('crate::data_paths::data_root()')
  expect(read('src-tauri/src/data_paths.rs')).toContain('.join("Krobi")')
})

it('keeps visible product copy in both manually maintained catalogs current', () => {
  for (const catalog of [en, es]) {
    const stale = Object.entries(catalog).filter(([key, value]) =>
      /\b(?:Krobi|KROBI)\b(?![/\\])/.test(key) || /\b(?:Krobi|KROBI)\b(?![/\\])/.test(value))
    expect(stale).toEqual([])
  }
  // Existing tests cover all source keys; English continues to repeat source copy.
  for (const [key, value] of Object.entries(en).filter(([key]) => key.includes('Flipspin'))) {
    expect(value).toBe(key.replace(/_(noun|full)$/, ''))
    expect(es).toHaveProperty(key)
  }
})

it('publishes the same server image across every installation surface', () => {
  expect(SERVER_IMAGE).toBe('ghcr.io/flipspin/flipspin-server')
  for (const path of ['.github/workflows/server-image.yml', '.github/workflows/release.yml', 'docker-compose.yml', 'deploy/install.sh', 'deploy/unraid/krobi-server.xml']) {
    const text = read(path)
    expect(text, path).toContain(SERVER_IMAGE)
    expect(text, path).not.toMatch(/ghcr\.io\/[^\s:}"']*krobi-server/)
  }
  expect(read('docker-compose.yml')).toContain('  flipspin:\n')
  expect(read('docker-compose.yml')).toContain('${KROBI_IMAGE:-')
})
