import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { AjustesContextValue, AjustesHost } from '../next/ajustes/context'
import type { AjustesPageProps } from '../next/ajustes/AjustesPage'
import type { SettingsContextValue, SettingsHost, SettingsPageProps } from './host'

vi.mock('./index', () => ({ plugins: [], pluginAddons: [], pluginComplementos: [], pluginPages: [], pluginRoutes: {}, pluginSettingsSections: [], pluginTrackMenuItems: () => [] }))

describe('plugin host compatibility', () => {
  it('keeps every old host import forwarding to the stable entry', async () => {
    const [host, context, page, data, support] = await Promise.all([
      import('./host'),
      import('../next/ajustes/context'),
      import('../next/ajustes/AjustesPage'),
      import('../data'),
      import('../next/settings/testSupport'),
    ])
    expect(context.useAjustes).toBe(host.useSettings)
    expect(context.AjustesProvider).toBe(host.SettingsProvider)
    expect(page.AjustesPage).toBe(host.SettingsPage)
    expect(host.useAjustes).toBe(host.useSettings)
    expect(host.AjustesProvider).toBe(host.SettingsProvider)
    expect(host.AjustesPage).toBe(host.SettingsPage)
    expect(data.DataProvider).toBe(host.DataProvider)
    expect(data.performRequest).toBe(host.performRequest)
    expect(data.queryKeys).toBe(host.queryKeys)
    expect(support.installFakeSettings).toBe(host.installFakeSettings)
    expect(support.serverStatus).toBe(host.serverStatus)
    const navigation = await import('../app/components/browse/navigationStore')
    const lyrics = await import('../app/components/lyrics/lyricsStore')
    const mac = await import('../app/components/lyrics/macEngine')
    const registry = await import('./index')
    const language = await import('../i18n')
    for (const name of ['push', 'currentRoute', 'reset'] as const) expect(navigation[name]).toBe(host[name])
    expect(lyrics.lyricsKeyOf).toBe(host.lyricsKeyOf)
    expect(mac.refreshMac).toBe(host.refreshMac)
    expect(mac.useMacEngine).toBe(host.useMacEngine)
    expect(host.default).toBe(language.default)
    expect(host.msg).toBe(language.msg)
    for (const name of ['pluginComplementos', 'pluginPages', 'pluginRoutes', 'pluginSettingsSections', 'pluginTrackMenuItems'] as const) expect(host[name]).toBe(registry[name])
    expect((await import('../app/components/settings/SettingsSection')).default).toBe(host.SettingsSection)
    expect((await import('../app/components/settings/SettingsSwitchRow')).default).toBe(host.SettingsSwitchRow)
    expect((await import('../app/components/shared/Select')).default).toBe(host.Select)
    expect((await import('../app/components/shared/CoverTile')).default).toBe(host.CoverTile)
    expect((await import('../app/components/browse/BrowseStates')).BrowseSkeleton).toBe(host.BrowseSkeleton)
    expect((await import('../app/components/browse/useAcquisition')).useAcquisition).toBe(host.useAcquisition)
    expect((await import('../next/data/test-support')).installFakeBackend).toBe(host.installFakeBackend)
    expectTypeOf<AjustesContextValue>().toEqualTypeOf<SettingsContextValue>()
    expectTypeOf<AjustesHost>().toEqualTypeOf<SettingsHost>()
    expectTypeOf<AjustesPageProps>().toEqualTypeOf<SettingsPageProps>()
  }, 30_000)
})
