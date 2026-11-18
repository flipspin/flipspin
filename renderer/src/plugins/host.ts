/**
 * Stable host imports for lazy plugin screens and their tests.
 * Keep this module out of eager plugin entry points: SettingsPage consumes the registry.
 * Existing implementation paths remain compatibility shims through v0.2.
 */
export * from '../settings/context'
export { useSettings as useAjustes, SettingsProvider as AjustesProvider } from '../settings/context'
export type { SettingsContextValue as AjustesContextValue, SettingsHost as AjustesHost } from '../settings/context'
export * from '../settings/SettingsPage'
export { SettingsPage as AjustesPage } from '../settings/SettingsPage'
export type { SettingsPageProps as AjustesPageProps } from '../settings/SettingsPage'
export * from '../data'
export * from '../settings/test-support'

export { push, currentRoute, reset } from '../browse/navigationStore'
export * from '../lyrics/lyricsStore'
export { refreshMac, useMacEngine } from '../lyrics/macEngine'
export { default, default as i18n, msg } from '../i18n'
export * from './types'
export { pluginComplementos, pluginPages, pluginRoutes, pluginSettingsSections, pluginTrackMenuItems } from './index'
export { default as SettingsSection } from '../settings/SettingsSection'
export { default as SettingsSwitchRow } from '../settings/SettingsSwitchRow'
export { default as Select } from '../ui/components/Select'
export { default as CoverTile } from '../ui/components/CoverTile'
export * from '../browse/BrowseStates'
export { useAcquisition } from '../browse/useAcquisition'
export { installFakeBackend } from '../data/test-support'
export type { FakeBackend, FakeBackendOptions, RecordedRequest as BackendRecordedRequest, ResponseSpec as BackendResponseSpec } from '../data/test-support'
