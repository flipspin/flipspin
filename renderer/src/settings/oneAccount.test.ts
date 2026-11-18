import { describe, expect, it } from 'vitest'

// contracts/ sits at the repo root, four levels up from this folder.
import contract from '../../../contracts/one-account.json'
import es from '../../locales/es/translation.json'
import en from '../../locales/en/translation.json'
import { ROLE_NAMES } from '../pairing/messages'

describe('contracts/one-account.json', () => {
  it.each(contract.roleLabel)('names the $role role «$label»', ({ role, label }) => {
    expect(es[ROLE_NAMES[role as keyof typeof ROLE_NAMES] as keyof typeof es]).toBe(label)
  })

  it('shows no word that makes the nest a house or a family', () => {
    const forbidden = new RegExp(`(^|[^\\p{L}])(${contract.forbidden.join('|')})(?![\\p{L}])`, 'iu')
    // Approved desktop copy uses casa for the network/location, never a role.
    const allowed = [...contract.allowed, 'fuera de casa']
    const offending = Object.values(es).filter((value) => {
      const rest = allowed.reduce((text, phrase) => text.toLocaleLowerCase('es-MX').split(phrase.toLocaleLowerCase('es-MX')).join(''), value)
      return forbidden.test(rest)
    })
    expect(offending).toEqual([])
    // The shared contract stays Spanish for phone clients. English values must
    // also contain none of that retired vocabulary (including untranslated copy).
    expect(Object.values(en).filter(value => forbidden.test(value))).toEqual([])
  })
})
