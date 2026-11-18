import { msg } from '../i18n'

/** Raw installer detail belongs in a tooltip and the helper log. */
export function installFailure(detail: string, target: 'engine' | 'lyrics' | 'stems'): string {
  if (/no space left|disk full|enospc|not enough space/i.test(detail)) return msg("There isn't enough disk space")
  if (/ssl|certificate|network|connection|timed? ?out|dns|resolve host|unreachable/i.test(detail)) return msg("Couldn't download: check the connection")
  if (/no solution found|resolution|unsatisfiable|dependency conflict|failed to resolve/i.test(detail)) return msg("Couldn't install engine dependencies")
  if (/aligner/i.test(detail)) return msg("Couldn't download the aligner model")
  return target === 'engine' ? msg("Couldn't install the engine") : msg("Couldn't download the models")
}
