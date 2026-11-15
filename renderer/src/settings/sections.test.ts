import { describe, expect, it } from 'vitest'
import { menuSection, resolveSection, type SectionId } from './sections'

// Explicit expectations protect saved ids independently of the current menu table.
const destinations: Record<string, SectionId> = {
  resumen: 'resumen', overview: 'resumen', complementos: 'complementos', addons: 'complementos', engines: 'complementos',
  equipo: 'equipo', computer: 'equipo', general: 'equipo', theme: 'equipo', atajos: 'equipo', shortcuts: 'equipo',
  almacenamiento: 'almacenamiento', storage: 'almacenamiento', dispositivos: 'dispositivos', devices: 'dispositivos',
  'aj-dispositivos': 'dispositivos', '#aj-dispositivos': 'dispositivos', cuenta: 'cuenta', account: 'cuenta',
  nido: 'nido', nest: 'nido', servidor: 'nido', server: 'nido', version: 'nido', equipos: 'equipos', helpers: 'equipos',
  biblioteca: 'biblioteca', library: 'biblioteca', import: 'biblioteca', importar: 'biblioteca',
  health: 'health', duplicates: 'duplicates', missing: 'missing', estimates: 'estimates', accuracy: 'accuracy',
  remoto: 'remoto', remote: 'remoto', cuentas: 'cuentas', accounts: 'cuentas', casa: 'cuentas',
  fuentes: 'fuentes', sources: 'fuentes', letras: 'letras', lyrics: 'letras', 'letras-nido': 'letras',
  'nest-lyrics': 'letras', 'lyrics-settings': 'letras', stems: 'stems', analisis: 'analisis', analysis: 'analisis',
  registro: 'registro', logs: 'registro', config: 'performance', performance: 'performance', network: 'network', security: 'security',
  extensiones: 'plugins', plugins: 'plugins', ties: 'ties', recommendations: 'recommendations',
  'sources-audio': 'sources-audio', 'sources-metadata': 'sources-metadata', 'sources-lyrics': 'sources-lyrics',
}

describe('saved settings destinations', () => {
  it.each(Object.entries(destinations))('%s and both saved hash spellings resolve to %s', (raw, expected) => {
    for (const prefix of ['', '#/ajustes/', '#/settings/']) expect(resolveSection(`${prefix}${raw}`)).toBe(expected)
  })
  it('resolves registered plugin ids and hashes under Plugins', () => {
    for (const prefix of ['', '#/ajustes/', '#/settings/']) expect(resolveSection(`${prefix}example-card`, ['example-card'])).toBe('plugins')
  })
  it.each(['sources-audio', 'sources-metadata', 'sources-lyrics', 'ties', 'recommendations'] as const)('keeps the parent selected for %s', id => {
    expect(menuSection(id)).toBe(id.startsWith('sources-') ? 'fuentes' : 'plugins')
  })
  it('falls back safely for unknown input, including inherited object keys', () => {
    for (const raw of [null, undefined, {}, '', 'unknown', 'constructor', 'toString']) expect(resolveSection(raw)).toBe('resumen')
  })
})
