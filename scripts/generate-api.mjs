#!/usr/bin/env node
/**
 * Generates the typed API surface from the backend's OpenAPI schema.
 *
 *   npm run api:generate                          # from the committed schema
 *   npm run api:generate -- --from <url|path>     # from a running server or a file
 *   npm run api:generate -- --from <url> --save   # ...and refresh the committed copy
 *
 * ── Why this generator ──────────────────────────────────────────────────────
 *
 * The candidates split into two families: emit *types only* and pair them with a
 * small typed fetch wrapper, or emit a full runtime SDK — a class or a function
 * per operation, with models, serialisers and a request core.
 *
 * Types-only won on three counts, all of them about this backend specifically:
 *
 *  1. The thing we are buying is that a renamed server field becomes a compile
 *     error *at our call sites*. A full SDK gives that too, but it also emits a
 *     few thousand lines of runtime code that has to be regenerated and
 *     re-reviewed on every schema refresh, so the rename arrives as a large diff
 *     in generated code rather than as a red squiggle where it matters.
 *  2. Half this backend's routes declare no response model — FastAPI emits
 *     `"schema": {}` for them, which is `unknown` either way. A runtime SDK
 *     would wrap those in generated methods that return `any` and look
 *     authoritative while telling you nothing. Types-only makes the gap visible:
 *     the response type is literally `unknown` until someone annotates the
 *     route in Python.
 *  3. Shipping less runtime code into a desktop webview is worth something on
 *     its own, and the fetch wrapper here is a few kilobytes against a generated
 *     client's tens.
 *
 * The full-SDK option that was closest to being worth it is also the one whose
 * output shape changes between minor releases, which would put churn in the
 * generated directory that has nothing to do with the backend changing.
 *
 * ── Why generation is offline by default ───────────────────────────────────
 *
 * The committed schema (renderer/api-schema.json) is the default input, not the
 * live server. A build that only typechecks when a FastAPI process happens to be
 * listening is a build that fails in CI, on a plane, and on any machine that has
 * not set up a Python environment. Refreshing the schema is a deliberate,
 * reviewable act — `--from <url> --save` — and the resulting diff is the record
 * of what the backend changed.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import openapiTS, { astToString } from 'openapi-typescript'

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..')
const COMMITTED_SCHEMA = path.join(REPO_ROOT, 'renderer/api-schema.json')
const OUT_DIR = path.join(REPO_ROOT, 'renderer/src/api/generated')
const OUT_FILE = path.join(OUT_DIR, 'schema.ts')

const BANNER = `/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * Every edit here is erased by the next \`npm run api:generate\`. This file
 * describes what the backend actually serves; if a type is wrong, the fix is in
 * the FastAPI route's response model, not here.
 *
 * Source: renderer/api-schema.json (a committed copy of the backend's
 * /openapi.json). To refresh it against a running server:
 *
 *   npm run api:generate -- --from http://127.0.0.1:8000 --save
 *
 * Routes that declare no response model in Python arrive here as \`unknown\`.
 * That is accurate, not a generator failure — annotate the route to fix it.
 */

`

const isUrl = (value) => /^https?:\/\//i.test(value)

function parseArgs(argv) {
  const args = { from: COMMITTED_SCHEMA, save: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--from') {
      const value = argv[i + 1]
      if (!value) throw new Error('--from needs a URL or a file path')
      args.from = value
      i += 1
    } else if (arg === '--save') {
      args.save = true
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  if (args.save && !isUrl(args.from)) {
    // Saving a file onto itself is a no-op that reads like it did something.
    throw new Error('--save only makes sense with --from <url>')
  }
  return args
}

async function loadSchema(from) {
  if (!isUrl(from)) {
    return JSON.parse(await readFile(from, 'utf-8'))
  }
  // Accept both the origin and the full path, since remembering which one the
  // script wants is exactly the kind of detail that makes a tool annoying.
  const url = from.endsWith('.json') ? from : `${from.replace(/\/+$/, '')}/openapi.json`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}. Is the backend running?`)
  }
  return response.json()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const schema = await loadSchema(args.from)

  if (args.save) {
    // Written the way the committed copy is formatted, so a refresh produces a
    // diff of real changes rather than a whole-file reformat.
    await writeFile(COMMITTED_SCHEMA, `${JSON.stringify(schema, null, 2)}\n`, 'utf-8')
    console.log(`schema saved → ${path.relative(process.cwd(), COMMITTED_SCHEMA)}`)
  }

  // rootTypes exports the component schemas as bare names as well as under
  // `components`, so call sites can write `PlaylistItem` instead of restating
  // the full index path every time they touch one.
  const ast = await openapiTS(schema, { rootTypes: true })
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, BANNER + astToString(ast), 'utf-8')

  const pathCount = Object.keys(schema.paths ?? {}).length
  const schemaCount = Object.keys(schema.components?.schemas ?? {}).length
  console.log(
    `generated → ${path.relative(process.cwd(), OUT_FILE)} (${pathCount} paths, ${schemaCount} schemas)`,
  )
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
