import type { ComponentType, PropsWithChildren } from 'react'
import type { MenuItem } from '../albums/TrackContextMenu'

// Entry points must not import host wiring (App, layout, BrowseRouter,
// SettingsModal or menu hosts): those modules import the registry. Lazy-load
// pages/settings so plugin discovery does not eagerly load feature screens.
export type PluginPage = { id: string; title: string; color: string; Component: ComponentType<{ albums: unknown[] }> }
export type PluginRoute = { kind: string; Component: ComponentType<{ route: { kind: string; id?: string; title: string }; albums: unknown[] }> }
export type PluginSettingsSection = { id: string; label: string; icon: ComponentType<{ size?: number; className?: string }>; color: string; Component: ComponentType }
/** Labels and values are translation keys from the plugin's locale bundles. */
export type PluginAddonState = { label: string; tone: 'ok' | 'warn' | 'bad' | 'off'; title?: string }
export type PluginAddonAction = { run: () => void; disabled?: boolean; title?: string }
export type PluginAddonRow = { value: string; values?: Record<string, string | number>; state: PluginAddonState }
export interface PluginAddon {
  id: string
  name: string
  icon: PluginSettingsSection['icon']
  kind: 'Extensión'
  description?: string
  nido: PluginAddonRow
  computer: PluginAddonRow & { install?: PluginAddonAction; remove?: PluginAddonAction }
  /** Optional live rows. Called only while mounted; do not fetch unless enabled. */
  useRows?: (enabled: boolean) => Pick<PluginAddon, 'nido' | 'computer'>
  /** A settings target renders the existing section inside its card. */
  open: { kind: 'settings' | 'page'; id: string }
}
export type TrackMenuContext = { count: number }
export interface KrobiPlugin {
  id: string
  onLoad?: (api: { log: import('../lib/log').ScopedLogger }) => void
  Provider?: ComponentType<PropsWithChildren>
  pages?: PluginPage[]
  routes?: PluginRoute[]
  settingsSections?: PluginSettingsSection[]
  complemento?: PluginAddon
  trackMenuItems?: (track: unknown, ctx: TrackMenuContext) => MenuItem[]
  locales?: Partial<Record<'es' | 'en', Record<string, string>>>
}

/** Compatibility names for independently shipped plugins. */
export type PluginComplementoState = PluginAddonState
export type PluginComplementoAction = PluginAddonAction
export type PluginComplementoRow = PluginAddonRow
export type PluginComplemento = PluginAddon
