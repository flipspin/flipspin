/** Share page fixtures across behavior suites; fake only HTTP and bridge boundaries. */
import { QueryClient } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { createElement, Fragment, lazy, useState } from 'react'
import { afterEach, vi } from 'vitest'
import i18n from '../i18n'
import { useSettingsNavigation } from './useSettingsNavigation'

import { Puzzle } from 'lucide-react'
import { SignInRequestsProvider } from '../auth/SignInRequestsProvider'
import { DataProvider, type CurrentUser, type ServerHost } from '../data'
import { __resetLyricsStoreForTest } from '../lyrics/lyricsStore'
import { SetupEmptyStates } from '../onboarding/SetupEmptyStates'
import { pluginAddons, pluginPages, pluginSettingsSections } from '../plugins'
import type { PluginAddon } from '../plugins/types'
import { SettingsPage } from './SettingsPage'
import type { SettingsHost, Surface } from './context'
import { forgetReachForTest } from './reachMemo'
import { installFakeSettings, serverStatus, type FakeSettings, type RecordedRequest, type ResponseSpec } from './test-support'

vi.mock('../plugins', async importOriginal => ({
  ...await importOriginal<typeof import('../plugins')>(),
  plugins: [], pluginAddons: [], pluginSettingsSections: [], pluginPages: [],
}))

export function fakePlugin(): PluginAddon {
  const card: PluginAddon = {
    id: 'example', name: 'Complemento de prueba', icon: Puzzle, kind: 'Extensión',
    nido: { value: 'Valor del nido', state: { label: 'Activo', tone: 'ok' } },
    computer: { value: 'Valor del equipo', state: { label: 'Sin instalar', tone: 'off' }, install: { run: vi.fn() }, remove: { run: vi.fn() } },
    open: { kind: 'settings', id: 'example-settings' },
  }
  pluginAddons.push(card)
  pluginSettingsSections.push({ id: 'example-settings', label: card.name, icon: Puzzle, color: 'purple', Component: lazy(async () => ({ default: () => createElement('p', null, 'Ajustes del complemento') })) })
  pluginPages.push({ id: 'example-settings', title: card.name, color: 'purple', Component: () => createElement('p', null, 'Página del complemento') })
  return card
}


export const ORIGIN = 'http://192.0.2.10:8000'
export const HANDSHAKE = { app: 'krobi', version: '2.1.2', instanceId: 'd0841ecc91ec409baff0158d62676123', name: 'Nido de krobi', isInit: true, authMethods: ['token'] }
export const GB = 1_000_000_000

export const ME_ADMIN = { id: 'u1', label: 'Owner', role: 'owner', isOwner: true, source: 'token', username: 'owner', createdAt: '2026-08-02T10:00:00Z', lastSeenAt: null }
export const ME_NORMAL = { id: 'u2', label: 'Member', role: 'member', isOwner: false, source: 'token', username: 'member', createdAt: '2026-09-12T10:00:00Z', lastSeenAt: null }

export const USERS = [
  { id: 'u1', label: 'Owner', role: 'owner', createdAt: '2026-08-02T10:00:00Z', lastSeenAt: new Date().toISOString() },
  { id: 'u2', label: 'Member', role: 'member', createdAt: '2026-09-12T10:00:00Z', lastSeenAt: null },
]

export const HOST: ServerHost = {
  hostname: 'krobi', os: { name: 'Debian GNU/Linux', version: '12' }, kernel: '7.0.14-12-pve', arch: 'x86_64',
  isolation: 'lxc', hypervisor: 'proxmox', cpu: { model: 'Intel(R) Core(TM) i7-8750H CPU @ 2.20GHz', cores: 4 },
  memory: { total: 4294967296, used: 122683392 }, python: '3.12.16', engine: 'agent',
  startedAt: new Date(Date.now() - 9 * 60_000).toISOString(), bootedAt: new Date(Date.now() - 21 * 86400_000).toISOString(),
}

export let fake: FakeSettings | null = null
afterEach(() => { void i18n.changeLanguage('es');
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index)
    if (key?.startsWith('krobi.settings.menu.')) localStorage.removeItem(key)
  }
  pluginAddons.length = 0
  pluginSettingsSections.length = 0
  pluginPages.length = 0
  fake?.restore()
  fake = null
  forgetReachForTest()
  __resetLyricsStoreForTest()
})

export function host(overrides: Partial<SettingsHost> = {}): SettingsHost {
  return {
    vlcIp: '',
    setVlcIp: vi.fn(),
    palette: 'paper',
    setPalette: vi.fn(),
    palettes: [{ id: 'paper', label: 'Paper', swatch: ['#E9ECF4', '#EF7E55', '#F1D86C'] }],
    mode: 'light',
    setMode: vi.fn(),
    ...overrides,
  }
}

interface Options {
  localLogs?: Parameters<typeof installFakeSettings>[0]['localLogs']
  navigation?: boolean
  local?: boolean
  installEngine?: Parameters<typeof installFakeSettings>[0]['installEngine']
  repairEngine?: Parameters<typeof installFakeSettings>[0]['repairEngine']
  macEngine?: Parameters<typeof installFakeSettings>[0]['macEngine']
  followup?: boolean
  me?: unknown
  section?: string
  surface?: Surface
  online?: boolean
  probe?: Parameters<typeof installFakeSettings>[0]['probe']
  respond?: (r: RecordedRequest) => ResponseSpec | undefined
  host?: Partial<SettingsHost>
}

function SettingsRoute({ host, surface }: { host: SettingsHost; surface: Surface }): React.JSX.Element {
  const [page, setPage] = useState('home')
  const request = useSettingsNavigation(() => setPage('settings'))
  return page === 'settings'
    ? createElement(SettingsPage, { key: request?.nonce, initialSection: request?.section, host, surface })
    : createElement('div', null, 'Inicio')
}

export function renderPage({ localLogs, local = false, followup = false, navigation = false, me = ME_ADMIN, section, surface = 'app', online = true, probe, respond, macEngine, repairEngine, installEngine, host: overrides }: Options = {}) {
  fake = installFakeSettings({
    macEngine, repairEngine, installEngine, localLogs,
    origin: ORIGIN,
    status: serverStatus({ mode: local ? 'child' : 'external', baseUrl: ORIGIN, ownedByUs: local }),
    probe: probe ?? (() => (online ? { ok: true, url: ORIGIN, handshake: HANDSHAKE } : { ok: false, reason: 'unreachable' })),
    respond: (r) => {
      const custom = respond?.(r)
      if (custom) return custom
      if (r.pathname === '/api/server/remote-route') return { status: 200, json: r.body }
      if (r.pathname === '/api/me') return me === null ? { status: 401, json: { detail: 'no' } } : { status: 200, json: me }
      // Anchor uptime to this response, even when a busy suite takes minutes
      // between importing the fixture and opening the status page.
      if (r.pathname === '/api/server/host') return { status: 200, json: { ...HOST, startedAt: new Date(Date.now() - 9 * 60_000).toISOString() } }
      if (r.pathname === '/api/server/storage') return { status: 200, json: { disk: { total: 32 * GB, free: 29.6 * GB }, music: 1.9 * GB, stems: 0.4 * GB, other: 0.1 * GB } }
      if (r.pathname === '/api/library/summary') return { status: 200, json: { folder: '/music', songs: 254, albums: 180, artists: 146 } }
      if (r.pathname === '/api/users') return { status: 200, json: { users: USERS } }
      if (r.pathname === '/api/me/devices') return { status: 200, json: { devices: [{ id: 'd1', label: 'MacBook de Owner', createdAt: null, lastSeenAt: null, isCurrent: true }, { id: 'd2', label: 'iPhone de Owner', createdAt: null, lastSeenAt: null, isCurrent: false }] } }
      if (r.pathname === '/api/server/network') return { status: 200, json: { lan: [ORIGIN], tailscale: null, externalUrl: null } }
      return undefined
    },
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const onClose = vi.fn()
  const view = render(createElement(DataProvider, {
    queryClient: client,
    children: createElement(SignInRequestsProvider, {
      me: me ? { ...(me as CurrentUser), onboarded: true } : null,
      children: createElement(Fragment, null,
        followup && createElement(SetupEmptyStates),
        navigation
          ? createElement(SettingsRoute, { host: host(overrides), surface })
          : createElement(SettingsPage, { initialSection: section, host: host(overrides), surface }),
      ),
    }),
  }))
  return { ...view, onClose, fake, client }
}

export const nav = () => screen.getByRole('navigation', { name: 'Secciones de ajustes' })


export function setPageFake(value: FakeSettings): FakeSettings {
  fake = value
  return value
}
