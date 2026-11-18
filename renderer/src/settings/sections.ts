/**
 * The sections of Settings, in the order the side menu draws them
 * (docs/features/settings.md). `label` is a `msg()` key: this table is built
 * once at import, so the render site does `t(section.label)`.
 *
 * `admin` sections are the nest's administration; an account that is not an
 * admin never sees their data; the menu hides them and deep links are gated.
 */
import type { LucideIcon } from 'lucide-react'
import { Cpu, HardDrive, FileText, Folder, Gauge, Globe, Layers, KeyRound, LayoutDashboard, MicVocal, Sparkles, GitFork, Laptop, Monitor, Network, Radio, Server, User, Users } from 'lucide-react'

import { msg } from '../i18n'

export type SectionId =
  | 'complementos'
  | 'plugins'
  | 'ties'
  | 'recommendations'
  | 'sources-audio'
  | 'sources-metadata'
  | 'sources-lyrics'
  | 'resumen'
  | 'equipo'
  | 'almacenamiento'
  | 'dispositivos'
  | 'cuenta'
  | 'nido'
  | 'equipos'
  | 'estimates'
  | 'health'
  | 'biblioteca'
  | 'duplicates'
  | 'missing'
  | 'remoto'
  | 'cuentas'
  | 'fuentes'
  | 'letras-nido'
  | 'letras'
  | 'stems'
  | 'analisis'
  | 'accuracy'
  | 'registro'
  | 'performance'
  | 'network'
  | 'security'

export interface SectionDef {
  id: SectionId
  label: string
  /** The title over the section, when it differs from the menu's word. */
  title?: string
  icon: LucideIcon
  /**
   * The section's hue: its menu tile, its heading mark, the stripe over its
   * cards. Theme variables (the bridge maps them onto the palette), so every
   * palette recolours it.
   */
  hue: string
  /** The hue's tint: the selected menu row. */
  tint: string
  group: 'top' | 'music' | 'features' | 'household' | 'computer' | 'system' | 'addon' | 'legacy'
  admin: boolean
  /** Nested menu destination; its parent keeps the current-page marker. */
  parent?: SectionId
}

export const SECTIONS: readonly SectionDef[] = [
  { id: 'resumen', label: msg("Overview"), icon: LayoutDashboard, hue: 'var(--color-text-primary)', tint: 'var(--color-bg-surface-secondary)', group: 'top', admin: false },
  { id: 'biblioteca', label: msg("Library"), icon: Folder, hue: 'var(--accent-green)', tint: 'var(--accent-green-tint)', group: 'music', admin: true },
  { id: 'health', label: msg("Library health"), icon: Folder, hue: 'var(--accent-green)', tint: 'var(--accent-green-tint)', group: 'addon', parent: 'biblioteca', admin: true },
  { id: 'performance', label: msg("Performance"), icon: Gauge, hue: 'var(--accent-rose)', tint: 'var(--accent-rose-tint)', group: 'music', admin: true },
  { id: 'network', label: msg("Network"), icon: Network, hue: 'var(--accent-blue)', tint: 'var(--accent-blue-tint)', group: 'music', admin: true },
  { id: 'security', label: msg("Security"), icon: KeyRound, hue: 'var(--accent-purple)', tint: 'var(--accent-purple-tint)', group: 'music', admin: true },
  { id: 'complementos', label: msg("Engines"), icon: Cpu, hue: 'var(--accent-purple)', tint: 'var(--accent-purple-tint)', group: 'features', admin: false },
  { id: 'letras', label: msg("Lyrics sync"), title: msg("Lyrics_plural"), icon: MicVocal, hue: 'var(--accent-purple)', tint: 'var(--accent-purple-tint)', group: 'addon', parent: 'complementos', admin: true },
  { id: 'stems', label: msg('Stems'), icon: Layers, hue: 'var(--accent-teal)', tint: 'var(--accent-teal-tint)', group: 'addon', parent: 'complementos', admin: true },
  { id: 'analisis', label: msg("Analysis"), icon: Folder, hue: 'var(--accent-amber)', tint: 'var(--accent-amber-tint)', group: 'addon', parent: 'complementos', admin: true },
  { id: 'fuentes', label: msg("Sources"), icon: Radio, hue: 'var(--accent-blue)', tint: 'var(--accent-blue-tint)', group: 'features', admin: true },
  { id: 'sources-audio', label: msg("Audio source"), icon: Radio, hue: 'var(--accent-blue)', tint: 'var(--accent-blue-tint)', group: 'addon', parent: 'fuentes', admin: true },
  { id: 'sources-metadata', label: msg('Metadata'), icon: Radio, hue: 'var(--accent-blue)', tint: 'var(--accent-blue-tint)', group: 'addon', parent: 'fuentes', admin: true },
  { id: 'sources-lyrics', label: msg('Lyrics_plural'), icon: Radio, hue: 'var(--accent-blue)', tint: 'var(--accent-blue-tint)', group: 'addon', parent: 'fuentes', admin: true },
  { id: 'plugins', label: msg('Plugins'), icon: GitFork, hue: 'var(--accent-yellow)', tint: 'var(--accent-yellow-tint)', group: 'features', admin: false },
  { id: 'ties', label: msg('Ties'), icon: GitFork, hue: 'var(--accent-yellow)', tint: 'var(--accent-yellow-tint)', group: 'addon', parent: 'plugins', admin: false },
  { id: 'recommendations', label: msg('Recommendations'), icon: Sparkles, hue: 'var(--accent-yellow)', tint: 'var(--accent-yellow-tint)', group: 'addon', parent: 'plugins', admin: false },
  { id: 'equipos', label: msg("Helpers_helpers"), icon: Cpu, hue: 'var(--accent-teal)', tint: 'var(--accent-teal-tint)', group: 'features', admin: true },
  { id: 'cuentas', label: msg("Accounts"), icon: Users, hue: 'var(--accent-purple)', tint: 'var(--accent-purple-tint)', group: 'household', admin: true },
  { id: 'remoto', label: msg("Remote access"), icon: Globe, hue: 'var(--accent-blue)', tint: 'var(--accent-blue-tint)', group: 'household', admin: false },
  { id: 'cuenta', label: msg("My account"), icon: User, hue: 'var(--accent-coral)', tint: 'var(--accent-coral-tint)', group: 'household', admin: false },
  { id: 'dispositivos', label: msg("My devices"), icon: Laptop, hue: 'var(--accent-blue)', tint: 'var(--accent-blue-tint)', group: 'household', admin: false },
  { id: 'equipo', label: msg('General'), icon: Monitor, hue: 'var(--accent-coral)', tint: 'var(--accent-coral-tint)', group: 'computer', admin: false },
  { id: 'almacenamiento', label: msg("Storage"), icon: HardDrive, hue: 'var(--accent-blue)', tint: 'var(--accent-blue-tint)', group: 'computer', admin: false },
  { id: 'nido', label: msg("Status"), title: msg("Nest status"), icon: Server, hue: 'var(--accent-teal)', tint: 'var(--accent-teal-tint)', group: 'system', admin: false },
  { id: 'registro', label: msg("Log"), icon: FileText, hue: 'var(--accent-yellow)', tint: 'var(--accent-yellow-tint)', group: 'system', admin: true },
  { id: 'estimates', label: msg("Review estimates"), icon: Folder, hue: 'var(--accent-amber)', tint: 'var(--accent-amber-tint)', group: 'legacy', admin: true },
  { id: 'duplicates', label: msg("Possible duplicates"), icon: Folder, hue: 'var(--accent-green)', tint: 'var(--accent-green-tint)', group: 'legacy', admin: true },
  { id: 'missing', label: msg("Missing files_translated"), icon: Folder, hue: 'var(--accent-green)', tint: 'var(--accent-green-tint)', group: 'legacy', admin: true },
  { id: 'letras-nido', label: msg("Lyrics_plural"), icon: MicVocal, hue: 'var(--accent-purple)', tint: 'var(--accent-purple-tint)', group: 'legacy', admin: true },
  { id: 'accuracy', label: msg("Accuracy"), icon: Folder, hue: 'var(--accent-amber)', tint: 'var(--accent-amber-tint)', group: 'legacy', admin: false },
]

const BY_ID = new Map(SECTIONS.map((section) => [section.id, section]))

export function sectionOf(id: SectionId): SectionDef {
  return BY_ID.get(id) ?? SECTIONS[0]
}

/**
 * The ids the old modal used (`openSettings('servidor')`, the lyrics modal's
 * `sources`, a plugin's own id…), so every deep link keeps landing where it
 * meant to.
 */
const LEGACY: Record<string, SectionId> = {
  config: 'performance',
  'addons': 'complementos',
  engines: 'complementos',
  'overview': 'resumen',
  'computer': 'equipo',
  'storage': 'almacenamiento',
  'devices': 'dispositivos',
  'account': 'cuenta',
  'nest': 'nido',
  'helpers': 'equipos',
  'library': 'biblioteca',
  'remote': 'remoto',
  'accounts': 'cuentas',
  'nest-lyrics': 'letras',
  'aj-dispositivos': 'dispositivos',
  '#aj-dispositivos': 'dispositivos',
  general: 'equipo',
  theme: 'equipo',
  atajos: 'equipo',
  shortcuts: 'equipo',
  casa: 'cuentas',
  servidor: 'nido',
  version: 'nido',
  server: 'nido',
  sources: 'fuentes',
  import: 'biblioteca',
  importar: 'biblioteca',
  lyrics: 'letras',
  'lyrics-settings': 'letras',
  'letras-nido': 'letras',
  analisis: 'analisis',
  analysis: 'analisis',
  logs: 'registro',
  extensiones: 'plugins',
}

/** A section id from anything a caller may pass; unknown → "Overview". */
export function resolveSection(raw: unknown, pluginIds: readonly string[] = []): SectionId {
  if (typeof raw !== 'string' || raw === '') return 'resumen'
  const id = raw.replace(/^#\/(?:ajustes|settings)\//, '')
  if (Object.hasOwn(LEGACY, id)) return LEGACY[id]
  if (BY_ID.has(id as SectionId)) return id as SectionId
  if (pluginIds.includes(id)) return 'plugins'
  return 'resumen'
}

/** Feature and library detail pages keep their parent selected. */
export function menuSection(id: SectionId): SectionId {
  if (['health', 'duplicates', 'missing', 'estimates'].includes(id)) return 'biblioteca'
  if (['letras', 'letras-nido', 'stems', 'analisis', 'accuracy'].includes(id)) return 'complementos'
  return sectionOf(id).parent ?? id
}
