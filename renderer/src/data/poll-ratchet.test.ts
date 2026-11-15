import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import baseline from '../../eslint-poll-baseline.json'

const root = join(__dirname, '../..')
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return path === join(root, 'src/api/generated') ? [] : entry.isDirectory() ? files(path) : /\.[jt]sx?$/.test(path) && !/\.test\./.test(path) ? [path] : []
  })
}
it('keeps only the documented progress/wait polls and ratchets their floor', () => {
  const actual: Record<string, number> = {}
  for (const file of files(join(root, 'src'))) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const path = relative(root, file).replaceAll('\\', '/')
    const visit = (node: ts.Node) => {
      const interval = ts.isPropertyAssignment(node) && node.name.getText(source).replaceAll(/["']/g, '') === 'refetchInterval'
      const scheduler = ts.isCallExpression(node) && ['startPoll', 'watchQueryPoll'].includes(node.expression.getText(source))
      if (interval || scheduler) {
        actual[path] = (actual[path] ?? 0) + 1
        expect(node.getText(source)).not.toMatch(/poll(?:Interval)?\(['"]idle['"]/)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect(actual).toEqual(Object.fromEntries(Object.entries(baseline).map(([file, entry]) => [file, entry.count])))
  expect(Object.values(actual).reduce((sum, count) => sum + count, 0)).toBe(18)
}, 30_000)
