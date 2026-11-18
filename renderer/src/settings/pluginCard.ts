/** Opens a plugin's own card in Settings → Plugins (SettingsPage listens). */
export const OPEN_PLUGIN_EVENT = 'krobi-open-plugin'

export function openPluginCard(id: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_PLUGIN_EVENT, { detail: { id } }))
}
