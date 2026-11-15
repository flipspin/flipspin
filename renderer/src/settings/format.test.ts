import i18n from '../i18n'
import { describe, expect, it } from 'vitest'

import { bareHost, formatBytes, formatSeen } from './format'
import { errorsToday, parseLog, sourceWord } from './logs'
import { resolveSection } from './sections'

describe('formatBytes', () => {
  it('counts in decimal units with the language’s comma', () => {
    expect(formatBytes(2_400_000_000)).toBe('2,4 GB')
    expect(formatBytes(32_000_000_000)).toBe('32 GB')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(-1)).toBe('—')
  })
})

describe('formatSeen', () => {
  const now = new Date('2026-10-27T12:00:00')
  it('says it the way a person does', () => {
    expect(formatSeen(null, now)).toBe('nunca')
    expect(formatSeen(new Date('2026-10-27T11:59:30').toISOString(), now)).toBe('ahora')
    expect(formatSeen(new Date('2026-10-27T08:12:00').toISOString(), now)).toMatch(/^hoy, 8:12/)
    expect(formatSeen(new Date('2026-10-26T22:00:00').toISOString(), now)).toMatch(/^ayer, 22:00/)
  })
})

describe('bareHost', () => {
  it('drops the scheme and the trailing slash', () => {
    expect(bareHost('http://192.168.1.20:8000/')).toBe('192.168.1.20:8000')
  })
})

describe('resolveSection', () => {
  it('maps the old modal’s ids and falls back to «Resumen»', () => {
    expect(resolveSection('servidor')).toBe('nido')
    expect(resolveSection('casa')).toBe('cuentas')
    expect(resolveSection('sources')).toBe('fuentes')
    expect(resolveSection('logs')).toBe('registro')
    expect(resolveSection('conexiones', ['conexiones'])).toBe('plugins')
    expect(resolveSection('extensiones')).toBe('plugins')
    expect(resolveSection('nope')).toBe('resumen')
    expect(resolveSection(null)).toBe('resumen')
  })
})

describe('parseLog', () => {
  it('reads both shapes, folds repeats and keeps tracebacks with their line', () => {
    const lines = [
      '{"timestamp": "2026-10-26T18:40:00Z", "level": "ERROR", "module": "app.domains.downloads.engine", "message": "yt-dlp: bot"}',
      '{"timestamp": "2026-10-26T18:42:07Z", "level": "ERROR", "module": "app.domains.downloads.engine", "message": "yt-dlp: bot"}',
      '2026-10-26 14:03:51 WARNING  app.domains.metadata.deezer_repository: quota exceeded (code 4)',
      'Traceback (most recent call last):',
    ]
    const entries = parseLog(lines)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ message: 'yt-dlp: bot', count: 2, level: 'ERROR' })
    expect(entries[1].raw).toContain('Traceback')
    expect(i18n.t(sourceWord(entries[0].module))).toBe('descargas')
    expect(i18n.t(sourceWord('app.middleware'))).toBe('nido')
  })

  it('counts today’s errors', () => {
    const today = new Date('2026-10-26T20:00:00Z')
    expect(errorsToday(['{"timestamp": "2026-10-26T18:00:00Z", "level": "ERROR", "module": "x", "message": "a"}', '{"timestamp": "2026-10-20T18:00:00Z", "level": "ERROR", "module": "x", "message": "b"}'], today)).toBe(1)
  })
})
