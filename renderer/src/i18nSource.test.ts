import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'
import en from '../locales/en/translation.json'

// Parse source syntax, not text matches: escaped quotes, template literals,
// conditionals and JSX attributes all carry the same catalog keys.
// Parses the entire renderer source tree and checks both translation inventories.
it('keeps every static host translation key in the English inventory', () => {
  const renderer = resolve(dirname(import.meta.filename), '..')
  const failures: string[] = []
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ['plugins', 'generated', '__snapshots__'].includes(entry.name)) continue
      const file = join(directory, entry.name)
      if (entry.isDirectory()) { walk(file); continue }
      if (!/\.tsx?$/.test(file) || /\.test\.|test-setup/.test(file)) continue
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
      const key = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          if (node.text && !Object.hasOwn(en, node.text)) {
            failures.push(`${file.slice(renderer.length + 1)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${node.text}`)
          }
        } else if (ts.isConditionalExpression(node)) { key(node.whenTrue); key(node.whenFalse) }
        else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) { key(node.left); key(node.right) }
        else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) key(node.expression)
      }
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.arguments[0] && (
          ts.isIdentifier(node.expression) && ['t', 'msg'].includes(node.expression.text)
          || ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 't'
        )) key(node.arguments[0])
        if (ts.isJsxAttribute(node) && node.name.getText(source) === 'i18nKey' && node.initializer) {
          if (ts.isJsxExpression(node.initializer) && node.initializer.expression) key(node.initializer.expression)
          else key(node.initializer)
        }
        if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'i18nKey') key(node.initializer)
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  for (const directory of ['src']) walk(join(renderer, directory))
  expect(failures).toEqual([])
}, 30000)
