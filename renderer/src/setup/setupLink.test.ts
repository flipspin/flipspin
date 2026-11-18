import { afterEach, describe, expect, it } from 'vitest'

// contracts/ sits at the repo root, four levels up from this folder.
import contract from '../../../contracts/setup-link.json'
import { forgetSetupCode, parseSetupLink, rememberSetupCode, setupCodeFor } from './setupLink'

describe('contracts/setup-link.json', () => {
  for (const c of contract.parse) {
    it(`parses ${JSON.stringify(c.input)}`, () => {
      const got = parseSetupLink(c.input)
      if ('error' in c) expect(got).toEqual({ ok: false, error: c.error })
      else expect(got).toEqual({ ok: true, address: c.address, code: c.code, redacted: c.redacted })
    })
  }
  for (const c of contract.make) {
    it(`reads back what the server makes for ${c.address}`, () => {
      expect(parseSetupLink(c.link)).toMatchObject({ ok: true, address: c.address, code: c.code })
    })
  }
})

describe('the remembered setup code', () => {
  afterEach(() => forgetSetupCode())

  it('is kept for the same nest only, and expires after an hour', () => {
    rememberSetupCode('http://192.168.1.20:8000', 'abcdefghijklmnopqrstuvwx', 1000)
    expect(setupCodeFor('http://192.168.1.20:8000', 2000)).toBe('abcdefghijklmnopqrstuvwx')
    expect(setupCodeFor('http://192.168.1.21:8000', 2000)).toBeNull()
    expect(setupCodeFor('http://192.168.1.20:8000', 1000 + 60 * 60 * 1000 + 1)).toBeNull()
    forgetSetupCode()
    expect(setupCodeFor('http://192.168.1.20:8000', 2000)).toBeNull()
  })
})
