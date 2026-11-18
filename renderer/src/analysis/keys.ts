import { msg } from '../i18n'
import { camelotCode } from '../home/libraryStories'

const MINOR = [msg("A♭ minor_name"), msg("E♭ minor_name"), msg("B♭ minor_name"), msg("F minor_name"), msg("C minor_name"), msg("G minor_name"), msg("D minor_name"), msg("A minor_name"), msg("E minor_name"), msg("B minor_name"), msg("F♯ minor_name"), msg("D♭ minor_name")]
const MAJOR = [msg("B major_name"), msg("F♯ major_name"), msg("D♭ major_name"), msg("A♭ major_name"), msg("E♭ major_name"), msg("B♭ major_name"), msg("F major_name"), msg("C major_name"), msg("G major_name"), msg("D major_name"), msg("A major_name"), msg("E major_name")]
export const KEY_OPTIONS = Array.from({ length: 12 }, (_, i) => ['A', 'B'].map(ring => ({ value: `${i + 1}${ring}`, name: (ring === 'A' ? MINOR : MAJOR)[i] }))).flat()
export function keyName(value: string): string {
  const code = camelotCode(value)
  return KEY_OPTIONS.find(option => option.value === code)?.name ?? value
}
export function keyCode(value: string): string { return camelotCode(value) ?? value }
