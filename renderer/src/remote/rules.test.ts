import { describe, expect, it } from 'vitest'

// contracts/ sits at the repo root, four levels up from this folder.
import contract from '../../../contracts/remote-access.json'
import { ago, reach, normalizeExternalUrl, probeVerdict, type ReachInput } from './rules'

describe('contracts/remote-access.json', () => {
  describe('externalUrl', () => {
    for (const c of contract.externalUrl) {
      it(c.case, () => {
        const result = normalizeExternalUrl(c.in)
        if ('error' in c) expect(result).toEqual({ error: c.error })
        else expect(result).toEqual({ url: c.out })
      })
    }
  })

  describe('probe', () => {
    for (const c of contract.probe) {
      it(c.case, () => {
        expect(probeVerdict(c.instanceId, c.answer as Record<string, unknown> | null)).toBe(c.out)
      })
    }
  })
})

for (const c of contract.ago) it(`ago: ${c.case}`, () => expect(ago(c.in)).toBe(c.out))
for (const c of contract.reach) it(`reach: ${c.case}`, () => expect(reach(c.in as ReachInput)).toEqual(c.out))


it('offers week units for uptime without changing the remote-access contract', () => {
  expect(ago(6 * 86400, { weeks: true })).toBe('hace 6 d')
  expect(ago(7 * 86400, { weeks: true })).toBe('hace 1 semana')
  expect(ago(21 * 86400, { weeks: true })).toBe('hace 3 semanas')
  expect(ago(40 * 86400)).toBe('hace 40 d')
})
