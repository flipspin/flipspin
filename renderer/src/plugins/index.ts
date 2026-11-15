import { pluginLogger } from '../lib/log'
import { registerPluginTranslations } from '../i18n'
import type { KrobiPlugin, PluginAddon, TrackMenuContext } from './types'

export function initializePlugin(directoryId: string, plugin: KrobiPlugin): void {
  plugin.onLoad?.({ log: pluginLogger(directoryId) })
}

const modules = import.meta.glob<{ default: KrobiPlugin }>('./*/plugin.tsx', { eager: true })
export const plugins = Object.keys(modules).sort().map((key) => modules[key].default)
for (const [index, plugin] of plugins.entries()) {
  const id = Object.keys(modules).sort()[index].split('/')[1]
  initializePlugin(id, plugin)
  for (const [language, bundle] of Object.entries(plugin.locales ?? {})) {
    registerPluginTranslations(language, bundle)
  }
}
export const pluginPages = plugins.flatMap((plugin) => plugin.pages ?? [])
export const pluginRoutes = Object.fromEntries(plugins.flatMap((plugin) => plugin.routes ?? []).map((route) => [route.kind, route]))
export const pluginSettingsSections = plugins.flatMap((plugin) => plugin.settingsSections ?? [])
// Keep pre-card plugins' settings reachable without an Extensiones screen.
export function addonsFor(plugin: KrobiPlugin): PluginAddon[] {
  return [
    ...(plugin.complemento ? [plugin.complemento] : []),
    ...(plugin.settingsSections ?? []).filter(section => plugin.complemento?.open.kind !== 'settings' || plugin.complemento.open.id !== section.id).map(section => ({
      id: `${plugin.id}:settings:${section.id}`, name: section.label, icon: section.icon, kind: 'Extensión' as const,
      nido: { value: '—', state: { label: '—', tone: 'off' as const } },
      computer: { value: '—', state: { label: '—', tone: 'off' as const } },
      open: { kind: 'settings' as const, id: section.id },
    })),
  ]
}
export const pluginAddons = plugins.flatMap(addonsFor)
/** @deprecated Kept for plugins until v0.2; use `pluginAddons`. */
export const pluginComplementos = pluginAddons
export function pluginTrackMenuItems(track: unknown, context: TrackMenuContext) {
  return plugins.flatMap((plugin) => plugin.trackMenuItems?.(track, context) ?? [])
}
