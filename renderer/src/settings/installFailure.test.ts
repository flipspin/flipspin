import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import en from '../../locales/en/translation.json'
import es from '../../locales/es/translation.json'
import { INSTALL_FAILURE_CAUSE, installFailureKey } from './installFailure'

const contract = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../contracts/source-plugin.json'), 'utf8')) as { installFailureCauses: string[] }

it('words every install failure cause the server can send, in both catalogs', () => {
  expect(Object.keys(INSTALL_FAILURE_CAUSE).sort()).toEqual([...contract.installFailureCauses].sort())
  for (const key of Object.values(INSTALL_FAILURE_CAUSE)) {
    expect(en).toHaveProperty([key])
    expect(es).toHaveProperty([key])
  }
})

it('falls back to the generic line for a cause this app does not know', () => {
  expect(installFailureKey('signature')).toBe(INSTALL_FAILURE_CAUSE.unknown)
  expect(installFailureKey(null)).toBe(INSTALL_FAILURE_CAUSE.unknown)
})
