import i18n from '../i18n'
import { expect, it } from 'vitest'
import { installFailure } from './installErrors'

it.each([
  ['uv: No solution found when resolving dependencies', 'No se pudieron instalar las dependencias del motor'],
  ['aligner: CERTIFICATE_VERIFY_FAILED', 'No se pudo descargar: revisa la conexión'],
  ['connection timed out', 'No se pudo descargar: revisa la conexión'],
  ['OSError: [Errno 28] No space left on device', 'No hay espacio suficiente'],
  ['aligner: SHA-256 mismatch', 'No se pudo descargar el alineador'],
])('maps installer detail to a short localized key: %s', (detail, key) => {
  expect(i18n.t(installFailure(detail, 'lyrics'))).toBe(key)
})
