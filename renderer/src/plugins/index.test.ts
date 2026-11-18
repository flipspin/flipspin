import { Puzzle } from 'lucide-react'
import type { PluginAddon, PluginAddonState, PluginAddonAction, PluginAddonRow, PluginComplemento, PluginComplementoState, PluginComplementoAction, PluginComplementoRow, KrobiPlugin } from './types'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { addonsFor, plugins, pluginAddons, pluginPages, pluginRoutes, pluginSettingsSections, pluginTrackMenuItems } from './index'

describe('local plugin registry', () => {
  it('exposes only contributions from discovered plugins', () => {
    expect(pluginPages).toEqual(plugins.flatMap((plugin) => plugin.pages ?? []))
    expect(Object.values(pluginRoutes)).toEqual(plugins.flatMap((plugin) => plugin.routes ?? []))
    expect(pluginSettingsSections).toEqual(plugins.flatMap((plugin) => plugin.settingsSections ?? []))
    expect(pluginTrackMenuItems(null, { count: 0 })).toEqual([])
  })
  it('does not require any plugin for a public build', () => {
    if (!Object.keys(import.meta.glob('./*/plugin.tsx')).length) {
      expect(plugins).toEqual([])
      expect(pluginAddons).toEqual([])
      expect(pluginPages).toEqual([])
      expect(pluginSettingsSections).toEqual([])
      expect(pluginRoutes).toEqual({})
    }
  })
})


describe('complemento compatibility cards', () => {
  const plugin: KrobiPlugin = { id: 'example', settingsSections: [
    { id: 'example-settings', label: 'Ejemplo', icon: Puzzle, color: 'purple', Component: () => null },
  ] }
  it('keeps an existing settings section reachable without a card contribution', () => {
    expect(addonsFor(plugin)).toMatchObject([{
      name: 'Ejemplo', kind: 'Extensión', open: { kind: 'settings', id: 'example-settings' },
      nido: { value: '—' }, computer: { value: '—' },
    }])
  })
  it('does not duplicate settings targeted by an explicit card; preserves settings alongside a page target', () => {
    const card = { id: 'example', name: 'Ejemplo', kind: 'Extensión' as const, icon: Puzzle,
      nido: { value: 'Nido', state: { label: 'Activo', tone: 'ok' as const } },
      computer: { value: 'Equipo', state: { label: 'Instalado', tone: 'ok' as const } },
      open: { kind: 'settings' as const, id: 'example-settings' },
    }
    expect(addonsFor({ ...plugin, complemento: card })).toEqual([card])
    const pageCard = { ...card, open: { kind: 'page' as const, id: 'example-settings' } }
    const cards = addonsFor({ ...plugin, complemento: pageCard })
    expect(cards).toHaveLength(2)
    expect(cards[0]).toEqual(pageCard)
    expect(cards[1].id).not.toBe(cards[0].id)
    expect(cards[1].open).toEqual({ kind: 'settings', id: 'example-settings' })
  })
})

it('assigns a logging prefix from the host directory rather than plugin metadata', async () => {
  const { initializePlugin } = await import('./index')
  const { setFakeBridgeForTest } = await import('../bridge')
  const invoke = vi.fn().mockResolvedValue(undefined)
  const restore = setFakeBridgeForTest({ invoke, on: () => () => undefined })
  try {
    initializePlugin('example', { id: 'pretend-to-be-core', onLoad: api => api.log.warn('hello\n[app]') })
    expect(invoke).toHaveBeenCalledWith('log:write', { level: 'warn', message: '[plugin:example] hello [app]' })
  } finally { restore() }
})

it('retains the external plugin type names and contract fields', () => {
  expectTypeOf<PluginComplemento>().toEqualTypeOf<PluginAddon>()
  expectTypeOf<PluginComplementoState>().toEqualTypeOf<PluginAddonState>()
  expectTypeOf<PluginComplementoAction>().toEqualTypeOf<PluginAddonAction>()
  expectTypeOf<PluginComplementoRow>().toEqualTypeOf<PluginAddonRow>()
  expectTypeOf<NonNullable<KrobiPlugin['complemento']>['nido']>().toEqualTypeOf<PluginAddonRow>()
})
