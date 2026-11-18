/** Typecheck verifies that generated models supersede fallback types.
 * Use fixed unannotated shapes so adding a server response model does not invalidate the test. */

import { describe, expect, it } from 'vitest'

import type { ServerHandshake } from '../lib/ipc'
import type { ApiDataOr, OrFallback, PathsWith, Unannotated } from './http'

type Exactly<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

/** Stands in for a route that has grown a real `response_model`. */
interface Modelled {
  app: string
  version: string
}

describe('Unannotated', () => {
  it('recognises both shapes a silent route produces', () => {
    // No `response_model` at all: FastAPI publishes `"schema": {}` and the
    // generator emits `unknown`; accurately.
    const noSchema: Exactly<Unannotated<unknown>, true> = true
    // Annotated `-> dict`: an open record. A different shape carrying the same
    // amount of information, which is none.
    const openRecord: Exactly<Unannotated<{ [key: string]: unknown }>, true> = true

    expect([noSchema, openRecord]).toEqual([true, true])
  })

  it('does not mistake a real model for a silent one', () => {
    // Literal keys are the whole signal: `string extends keyof T` is false for
    // any model the server actually published, which is what makes the fallback
    // step aside on its own.
    const model: Exactly<Unannotated<Modelled>, false> = true
    const list: Exactly<Unannotated<Modelled[]>, false> = true

    expect([model, list]).toEqual([true, true])
  })
})

describe('OrFallback', () => {
  it('uses the local shape only while the server publishes none', () => {
    const whileSilent: Exactly<OrFallback<unknown, Modelled>, Modelled> = true
    const whileDict: Exactly<OrFallback<{ [key: string]: unknown }, Modelled>, Modelled> = true
    // A generated model must supersede a conflicting fallback so obsolete fields fail compilation.
    const onceModelled: Exactly<OrFallback<{ id: string }, Modelled>, { id: string }> = true

    expect([whileSilent, whileDict, onceModelled]).toEqual([true, true, true])
  })

  it('keeps the handshake assignable to the contract main already uses', () => {
    // `server:probe` in main reads this same route into `ServerHandshake`. The
    // two must not drift, whichever side of `OrFallback` is currently winning.
    const compatible: ApiDataOr<'/api/status', 'get', ServerHandshake> extends ServerHandshake ? true : false = true
    expect(compatible).toBe(true)
  })
})

describe('PathsWith', () => {
  it('offers a route to a verb only when the server routes that verb', () => {
    // What stops `apiGet` being pointed at a POST-only route: otherwise a 405
    // that shows up at run time, on somebody's machine, on a screen nobody
    // thought to test.
    const hasGet: '/api/me' extends PathsWith<'get'> ? true : false = true
    const postOnly: '/api/set-basedir' extends PathsWith<'get'> ? true : false = false

    expect([hasGet, postOnly]).toEqual([true, false])
  })
})
