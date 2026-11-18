import { describe, expect, it } from 'vitest'
import contract from '../../../contracts/delete-account.json'
import { doLabel, facts, optionB, toast, type DeleteChoice } from './deleteAccount'
import { formatBytes } from './format'

describe('contracts/delete-account.json', () => {
  // The shared fixtures still describe the phones. Desktop uses approved es-MX.
  const desktopCopy = (out: string) => out.replace(/\blista(s?)\b/g, 'playlist$1').replace(/borrada(s?)/g, 'eliminada$1').replace(/libres/g, 'liberados')
  it.each(contract.facts)('facts: $out', ({ in: input, out }) => expect(facts(input)).toBe(desktopCopy(out)))
  it.each(contract.doLabel)('button: $case', ({ choice, removable, out }) => expect(doLabel(choice as DeleteChoice, removable)).toBe(out))
  it.each(contract.optionB)('option B: $case', ({ preview, enabled, why }) => expect(optionB(preview)).toEqual({ enabled, why }))
  it.each(contract.size)('size: $out', ({ in: input, out }) => expect(formatBytes(input)).toBe(out))
  it.each(contract.toast)('toast: $case', ({ name, out, ...result }) => expect(toast(name, result)).toBe(desktopCopy(out)))
})
