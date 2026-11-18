/**
 * Renderer boundary ratchet. Boundary rules are warnings so existing debt can
 * remain visible in ESLint; this test makes any increase fail lint and tests.
 * After removing debt, UPDATE_ESLINT_BASELINE=1 npm run lint lowers the floor.
 * Updating an existing baseline never accepts an increase.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { ESLint } from 'eslint'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const RENDERER = resolve(__dirname, '../..')
const BASELINE_FILE = join(RENDERER, 'eslint-baseline.json')
const HAND_TYPES = 'no-hand-response-types'
const BOUNDARY_RULES = new Set([
  'no-restricted-imports', 'no-restricted-properties', 'no-restricted-syntax',
])
type Counts = Record<string, Record<string, number>>
const rel = (file: string) => relative(RENDERER, file).split('\\').join('/')
const boundaryESLint = () => new ESLint({
  cwd: dirname(RENDERER),
  overrideConfigFile: join(RENDERER, 'eslint.config.js'),
  // The CLI already checks the other rules; keep this scan focused and cheap.
  ruleFilter: ({ ruleId }) => BOUNDARY_RULES.has(ruleId),
  // Suppressing a warning in source must not bypass the baseline.
  overrideConfig: { linterOptions: { noInlineConfig: true } },
})

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    // Only this generated tree is exempt; tests and other generated-named
    // directories must not become an escape hatch.
    if (path === join(RENDERER, 'src/api/generated')) return []
    return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?tsx?$/.test(entry.name) ? [path] : []
  })
}

function responseDeclarations(text: string, file = 'fixture.ts'): number {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  let count = 0
  function visit(node: ts.Node) {
    if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && /^\w+Response$/.test(node.name.text)) count++
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

function increases(now: Counts, baseline: Counts): string[] {
  return Object.entries(now).flatMap(([file, rules]) =>
    Object.entries(rules).flatMap(([rule, count]) => {
      const floor = baseline[file]?.[rule] ?? 0
      return count > floor ? [`${file} ${rule}: ${floor} → ${count}`] : []
    }),
  )
}

function sorted(counts: Counts): Counts {
  return Object.fromEntries(Object.keys(counts).sort().map((file) => [file,
    Object.fromEntries(Object.entries(counts[file]).sort(([a], [b]) => a.localeCompare(b))),
  ]))
}

describe('renderer boundaries', () => {
  it('restricts deprecated routes, native access and audio output', async () => {
    const eslint = boundaryESLint()
    const cases: [string, string, string | null][] = [
      ["src/data/fixture.ts", "({ refetchInterval: 5000 })", "no-restricted-syntax"],
      ["src/settings/fixture.ts", "window.setInterval(check, 5000)", "no-restricted-syntax"],
      ["src/data/fixture.ts", "setInterval(check, 5000)", "no-restricted-syntax"],
      ["src/data/fixture.ts", "({ refetchInterval: () => poll('idle') })", "no-restricted-syntax"],
      ["src/data/poll.ts", "setInterval(check, 5000)", null],
      ["src/auth/CodeSignIn.tsx", "setInterval(clock, 1000)", null],
      ["src/library/fixture.tsx", "<audio autoPlay />", "no-restricted-syntax"],
      ["src/library/fixture.ts", "new window.Audio()", "no-restricted-syntax"],
      ["src/library/fixture.ts", "el['play']()", "no-restricted-syntax"],
      ["src/library/fixture.ts", "ctx['destination']", "no-restricted-syntax"],
      ["src/library/fixture.ts", "new Audio(\"song.mp3\")", "no-restricted-syntax"],
      ["src/library/fixture.ts", "ctx.createMediaElementSource(audio)", "no-restricted-syntax"],
      ["src/library/fixture.ts", "audio.play()", "no-restricted-syntax"],
      ["src/library/fixture.ts", "audioRef.current.play()", "no-restricted-syntax"],
      ["src/library/fixture.ts", "video.play()", "no-restricted-syntax"],
      ["src/library/fixture.ts", "el.play()", "no-restricted-syntax"],
      ["src/library/fixture.ts", "ctx.destination", "no-restricted-syntax"],
      ["src/stems/fixture.ts", "ctx.destination", "no-restricted-syntax"],
      ["src/player/engine/fixture.ts", "new Audio(\"fixture\")", null],
      ["src/stems/audioGraph.ts", "ctx.destination", null],
      ["src/api/fixture.ts", "import x from '../next/data'", "no-restricted-imports"],
      ["src/api/fixture.ts", "export * from '../app/components/browse/navigationStore'", "no-restricted-imports"],
      ["src/api/fixture.ts", "void import('../next/data')", "no-restricted-syntax"],
      ["src/api/fixture.ts", "type X = import('../next/data').X", "no-restricted-syntax"],
      ["src/api/fixture.ts", "import { x } from '@lib/api'", null],
      ["src/api/fixture.ts", "import { x } from '../data'", null],
      ["src/api/fixture.ts", "void window.krobi", "no-restricted-properties"],
      ["src/library/fixture.ts", "void window?.['krobi']", "no-restricted-properties"],
      ["src/library/fixture.jsx", "const { krobi } = window", "no-restricted-properties"],
      ["src/bridge.ts", "void window.krobi", null],
      ["src/desktop/tauri.ts", "void window.krobi", null],
      ["src/web/fixture.ts", "void window.krobi", null],
    ]
    for (const [file, text, rule] of cases) {
      const [result] = await eslint.lintText(text, { filePath: join(RENDERER, file) })
      const boundaryRules = result.messages.filter((message) => BOUNDARY_RULES.has(message.ruleId ?? '')).map((message) => message.ruleId)
      expect(boundaryRules, `${file}: ${text}`).toEqual(rule ? [rule] : [])
    }
  }, 30_000)

  it('recognises response declarations, including nested and multiline types', () => {
    expect(responseDeclarations(`
      // interface CommentResponse {}
      const example = 'type StringResponse = {}'
      interface FooResponse {}
      type BarResponse = { ok: boolean }
      namespace Nested { export interface BazResponse<T> { value: T } }
      type MultiResponse\n        = unknown
      interface Response {}
    `)).toBe(4)
  })

  it('allows decreases and removals, but rejects increases and new files', () => {
    const baseline = { 'src/old.ts': { rule: 2 } }
    expect(increases({ 'src/old.ts': { rule: 1 } }, baseline)).toEqual([])
    expect(increases({}, baseline)).toEqual([])
    expect(increases({ 'src/old.ts': { rule: 3 } }, baseline)).toHaveLength(1)
    expect(increases({ 'src/new.ts': { rule: 1 } }, baseline)).toHaveLength(1)
    expect(increases({ 'src/old.ts': { otherRule: 1 } }, baseline)).toHaveLength(1)
  })

  // Runs ESLint and TypeScript syntax analysis across the complete renderer tree.
  it('never adds an ESLint boundary violation or a hand-written Response type (ratchet)', async () => {
    const eslint = boundaryESLint()
    const now: Counts = {}
    const add = (file: string, rule: string, count = 1) => {
      if (count) (now[file] ??= {})[rule] = (now[file]?.[rule] ?? 0) + count
    }
    for (const result of await eslint.lintFiles(['renderer'])) {
      for (const message of result.messages) {
        // Parse errors cannot silently hide a boundary violation.
        expect(message.fatal, `${rel(result.filePath)}: ${message.message}`).not.toBe(true)
        if (BOUNDARY_RULES.has(message.ruleId ?? '')) add(rel(result.filePath), message.ruleId!)
      }
    }
    const pending = new Set<string>(JSON.parse(readFileSync(join(RENDERER, 'eslint-typing-pending.json'), 'utf8')))
    for (const file of sourceFiles(join(RENDERER, 'src'))) {
      if (pending.has(rel(file))) continue
      add(rel(file), HAND_TYPES, responseDeclarations(readFileSync(file, 'utf8'), file))
    }

    const update = process.env.UPDATE_ESLINT_BASELINE === '1'
    // Initial creation is explicit. Deleting the floor must not silently bless debt.
    expect(existsSync(BASELINE_FILE) || update, 'Missing renderer/eslint-baseline.json').toBe(true)
    const baseline: Counts = existsSync(BASELINE_FILE) ? JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) : now
    expect(increases(now, baseline),
      'Boundary debt increased. Use feature modules, bridge(), and generated API types. UPDATE_ESLINT_BASELINE=1 npm run lint only lowers the floor.',
    ).toEqual([])

    if (update) {
      writeFileSync(BASELINE_FILE, `${JSON.stringify(sorted(now), null, 2)}\n`)
      console.info('Updated renderer/eslint-baseline.json to the current lower floor.')
    } else {
      const removed = Object.entries(baseline).flatMap(([file, rules]) =>
        Object.entries(rules).flatMap(([rule, floor]) => {
          const count = now[file]?.[rule] ?? 0
          return count < floor ? [`${file} ${rule}: ${floor} → ${count}`] : []
        }),
      )
      if (removed.length) console.info(`Boundary debt decreased:\n${removed.join('\n')}\nLower the floor with UPDATE_ESLINT_BASELINE=1 npm run lint`)
    }
  }, 120000)
})
