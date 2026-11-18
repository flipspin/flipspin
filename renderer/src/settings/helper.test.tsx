import i18n from '../i18n'
import { describe, expect, it } from 'vitest'
import contract from '../../../contracts/helper.json'
import { menuSection, resolveSection, type SectionId } from './sections'
import { HELPER_STATES, capable, fastestHelper, helperKind, helperSpeed, waitWord, type Helper, type JobKind } from './helper'

describe('contract check 12 — contracts/helper.json', () => {
  // Shared fixtures retain the phones' copy; this pass changes desktop only.
  const desktopStates: Record<string, string> = { idle: 'Disponible', asleep: 'En reposo', closed: 'Flipspin cerrado' }
  it.each(contract.states)('state $input → $word', c => expect(i18n.t(HELPER_STATES[c.input].word)).toBe(desktopStates[c.input] ?? c.word))
  it.each(contract.accel)('accel $input → $word', c => expect(i18n.t(helperKind(c.input as Helper['accel']))).toBe(c.word))
  it.each(contract.waitReason)('waitReason $input → $word', c => expect(i18n.t(waitWord(c.input as Parameters<typeof waitWord>[0]))).toBe(c.word))
  it.each(contract.snapshots)('$name', c => {
    const kind = c.input.kind as JobKind
    const selected = fastestHelper(c.input.helpers.map(h => ({ ...h, version: '0.15.6', minimumVersion: '0.10.0', versionState: 'current' })) as Helper[], kind)
    expect(selected?.id ?? null).toBe(c.who)
    const speed = helperSpeed(selected, kind)
    expect({ ...speed, reason: i18n.t(speed.reason) }).toEqual({ value: c.speed, reason: c.speedReason })
  })
})

it('analysis remains available on a computer below the shared engine memory gate', () => {
  expect(capable({ jobs: ['analysis'], memoryBytes: 1, os: 'linux', accel: 'cpu' }, 'analysis')).toBe(true)
})


it.each(['letras-nido', 'nest-lyrics', 'lyrics-settings', 'lyrics'])('redirects the legacy Lyrics id %s to the merged page', id => {
  expect(resolveSection(id)).toBe('letras')
})
it.each(['letras', 'stems', 'analisis', 'accuracy'] as SectionId[])('selects Engines for %s', id => {
  expect(menuSection(id)).toBe('complementos')
})
it.each(['health', 'duplicates', 'missing', 'estimates'] as SectionId[])('selects Library for %s', id => {
  expect(menuSection(id)).toBe('biblioteca')
})

it.each([
  ['addons', 'complementos'], ['overview', 'resumen'], ['computer', 'equipo'],
  ['storage', 'almacenamiento'], ['devices', 'dispositivos'], ['account', 'cuenta'],
  ['nest', 'nido'], ['helpers', 'equipos'], ['library', 'biblioteca'],
  ['remote', 'remoto'], ['accounts', 'cuentas'], ['sources', 'fuentes'],
  ['lyrics', 'letras'], ['nest-lyrics', 'letras'], ['analysis', 'analisis'],
  ['logs', 'registro'], ['aj-dispositivos', 'dispositivos'], ['#aj-dispositivos', 'dispositivos'],
])('keeps %s as an alias of the established section %s', (alias, saved) => {
  expect(resolveSection(alias)).toBe(saved)
  expect(resolveSection(saved)).toBe(saved)
})
