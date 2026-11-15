import { describe, expect, it } from 'vitest'
import contract from '../../../contracts/sign-in-code.json'
import { CODE_ALPHABET, CODE_LENGTH, CODE_EXPIRY_SECONDS, CODE_POLL_SECONDS, normalizeSignInCode, validSignInCode, displaySignInCode, codeExpiry } from './signInCode'

describe('shared sign-in-code contract', () => {
  it('pins alphabet, length, TTL and polling', () => {
    expect(CODE_ALPHABET).toBe(contract.alphabet)
    expect(CODE_LENGTH).toBe(contract.length)
    expect(CODE_EXPIRY_SECONDS).toBe(contract.expiresIn)
    expect(CODE_POLL_SECONDS).toBe(contract.pollInterval)
  })
  for (const test of contract.format) it(`formats ${test.input}`, () => {
    expect(normalizeSignInCode(test.input)).toBe(test.normalized)
    expect(validSignInCode(test.input)).toBe(test.valid)
    expect(displaySignInCode(test.input)).toBe(test.display)
  })
  for (const test of contract.expiry) it(`displays expiry ${test.seconds}`, () => {
    expect(codeExpiry(test.seconds)).toBe(test.display)
  })
})
