import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { expect, it } from 'vitest'

it('C6 removes trace code and its marker from a production Vite build', () => {
  const root = resolve(import.meta.dirname, '../../..')
  const output = mkdtempSync(join(tmpdir(), 'krobi-player-build-'))
  try {
    execFileSync(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'renderer/vite.config.js', '--outDir', output], {
      cwd: root, env: { ...process.env, KROBI_PLAYBACK_TRACE: '0' }, stdio: 'pipe', timeout: 120000,
    })
    const js = readdirSync(join(output, 'assets')).filter(name => name.endsWith('.js'))
    expect(js.length).toBeGreaterThan(0)
    for (const file of js) {
      const code = readFileSync(join(output, 'assets', file), 'utf8')
      for (const marker of ['__krobi_trace__', 'element-progress', 'rebufferMs']) expect(code, file).not.toContain(marker)
    }
  } finally { rmSync(output, { recursive: true, force: true }) }
}, 150000)
