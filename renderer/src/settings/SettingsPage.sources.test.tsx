import { configure, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import fixture from '../../../contracts/wire/server-config.json'
import i18n from '../i18n'
import { queryKeys } from '../data'
import { type Provider } from './data'
import { type ServerConfig } from './config'
import { sourceNeedsAction } from './sourceHealth'
import { ME_NORMAL, renderPage } from './page-test-support'

configure({ asyncUtilTimeout: 5000 })

const now = () => Date.now() / 1000
const youtube = (overrides: Partial<Provider> = {}): Provider => ({
  id: 'youtube', kind: 'streaming', name: 'YouTube', enabled: true, position: 0, available: true,
  requiresCredentials: false, capabilities: ['stream'], unavailableReason: null, health: { state: 'ok' }, format: null,
  status: { revision: 'one', facts: [{ label: 'Tool', value: 'one', tip: 'Verified' }, { label: 'Format', value: 'AAC · m4a' }], actions: [{ id: 'update', label: 'Update now' }], toggles: [{ id: 'auto-update', label: 'Update automatically', value: true }] },
  ...overrides,
})
function setup(source: Provider, section = 'sources-audio', member = false) {
  let provider = source
  const config = structuredClone(fixture) as ServerConfig
  return renderPage({ section, me: member ? ME_NORMAL : undefined, respond: r => {
    if (r.pathname === '/api/providers') return { status: 200, json: { providers: [provider] } }
    if (r.pathname === '/api/providers/youtube/retry') {
      provider = { ...provider, health: { state: 'ok', until: null, level: provider.health?.level } }
      return { status: 200, json: provider.health }
    }
    if (r.pathname === '/api/providers/youtube' && r.method === 'PUT') {
      provider = { ...provider, enabled: (r.body as { enabled: boolean }).enabled }
      return { status: 200, json: provider }
    }
    if (r.pathname === '/api/sources/youtube/action') {
      const body = r.body as { id: string; value?: boolean }
      provider = { ...provider, status: { ...provider.status, ...(body.id === 'update' ? { facts: [{ label: 'Tool', value: 'two' }] } : { toggles: [{ id: 'auto-update', label: 'Update automatically', value: body.value! }] }) } }
      return { status: 200, json: provider.status }
    }
    if (r.pathname === '/api/server/config') {
      if (r.method === 'PUT') for (const row of config.groups.flatMap(group => group.settings)) {
        if (row.key === 'KROBI_YTDLP_AUTO_UPDATE') row.value = (r.body as { changes: Record<string, unknown> }).changes[row.key]
      }
      return { status: 200, json: config }
    }
    if (r.pathname === '/api/config/ytdlp-cookies') return { status: 200, json: { cookies_from_browser: '', cookies_file: '' } }
    if (r.pathname === '/api/lyrics/jobs') return { status: 200, json: { withLyrics: 200, pendingCount: 0, pending: [], running: null, queued: 0 } }
    return undefined
  } })
}
const busy = (hours = 1): Provider['health'] => ({ state: 'busy', kind: 'rate-limited', level: 3, since: now() - hours * 3600, firstFailureAt: now() - hours * 3600, lastFailureAt: now() - 60, until: now() + 600 })

it('shows Busy, structured failure tooltip, and Try now returning to Ready after the next read', async () => {
  await i18n.changeLanguage('en')
  const { fake } = setup(youtube({ health: busy() }))
  const word = await screen.findByText(/^Busy until/)
  expect(word).toHaveAttribute('title', expect.stringContaining('Rate-limited · First failure'))
  expect(word.title).toContain('Last failure')
  expect(word.title).toContain('Until')
  expect(screen.getByText('YouTube asked to slow down · retries by itself')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Try now' }))
  expect(await screen.findByText('Ready')).toBeVisible()
  expect(fake.requests.some(r => r.pathname === '/api/providers/youtube/retry' && r.method === 'POST')).toBe(true)
  expect(fake.requests.filter(r => r.pathname === '/api/providers')).toHaveLength(2)
})

it.each([
  { health: busy(), count: 0 },
  { health: busy(5.99), count: 0 },
  { health: busy(6.1), count: 1 },
  { health: { ...busy(), state: 'broken', kind: 'blocked' }, count: 1 },
  { health: { ...busy(), state: 'broken', kind: 'auth-required' }, count: 1 },
] as { health: Provider['health']; count: number }[])('Overview shows $count source to-dos for $health.kind', async ({ health, count }) => {
  await i18n.changeLanguage('en')
  const { client } = setup(youtube({ health }), 'resumen')
  await waitFor(() => expect(client.getQueryData(queryKeys.server.providers())).toBeDefined())
  const group = (await screen.findByRole('heading', { name: 'To do' })).closest('.settings-block')!
  expect(within(group as HTMLElement).queryAllByRole('button', { name: 'Open Sources' })).toHaveLength(count)
  if (count) {
    expect(group).toHaveTextContent('YouTube')
    await userEvent.click(within(group as HTMLElement).getByRole('button', { name: 'Open Sources' }))
    expect(await screen.findByRole('heading', { name: 'Audio source', level: 2 })).toBeVisible()
  }
})

it('coalesces broken health and a rolled-back stale tool into one source to-do with a working retry', async () => {
  await i18n.changeLanguage('en')
  const source = youtube({ health: { ...busy(), state: 'broken', kind: 'broken' } })
  source.status = { ...source.status, warning: 'Tool needs attention' }
  const { fake } = setup(source, 'resumen')
  await screen.findByRole('button', { name: 'Try now' })
  expect(screen.getAllByRole('button', { name: 'Open Sources' })).toHaveLength(1)
  await userEvent.click(screen.getByRole('button', { name: 'Try now' }))
  await waitFor(() => expect(fake.requests.some(r => r.pathname === '/api/providers/youtube/retry')).toBe(true))
})

it('shows a plugin warning once while health is ready', async () => {
  await i18n.changeLanguage('en')
  setup(youtube({ status: { warning: 'Tool needs attention' } }), 'resumen')
  expect(await screen.findByText('Tool needs attention')).toBeVisible()
  expect(screen.getAllByRole('button', { name: 'Open Sources' })).toHaveLength(1)
})

it('renders source facts, actions and toggles through the generic protocol', async () => {
  await i18n.changeLanguage('en')
  const { fake } = setup(youtube())
  await userEvent.click(await screen.findByRole('button', { name: 'Open YouTube' }))
  expect(await screen.findByText('AAC · m4a')).toBeVisible()
  expect(screen.getByText('Tool')).toHaveAttribute('title', 'Verified')
  await userEvent.click(screen.getByRole('switch', { name: 'Update automatically' }))
  await waitFor(() => expect(fake.requests.find(r => r.pathname === '/api/sources/youtube/action')?.body).toEqual({ id: 'auto-update', value: false }))
  await userEvent.click(screen.getByRole('button', { name: 'Update now' }))
  expect(await screen.findByText('two')).toBeVisible()
  expect(screen.getByRole('combobox', { name: 'Browser' })).toBeVisible()
})

it('allows switching off the last audio source and renders zero enabled audio sources without an error', async () => {
  await i18n.changeLanguage('en')
  const { fake } = setup(youtube())
  await userEvent.click(await screen.findByRole('switch', { name: 'YouTube' }))
  expect(await screen.findByText('0 of 1')).toBeVisible()
  expect(screen.getByRole('switch', { name: 'YouTube' })).not.toBeChecked()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(fake.requests.find(r => r.pathname === '/api/providers/youtube' && r.method === 'PUT')?.body).toEqual({ enabled: false })
})

it('keeps source to-dos out of member Overview', async () => {
  await i18n.changeLanguage('en')
  const { fake } = setup(youtube({ health: { ...busy(), state: 'broken', kind: 'blocked' } }), 'resumen', true)
  await screen.findByRole('heading', { name: 'Overview', level: 2 })
  expect(screen.queryByRole('button', { name: 'Open Sources' })).not.toBeInTheDocument()
  expect(fake.requests.some(r => r.pathname === '/api/providers')).toBe(false)
})

it('starts the long-outage to-do strictly after six hours', () => {
  const source = youtube({ health: { state: 'busy', kind: 'rate-limited', since: 10000 } })
  expect(sourceNeedsAction(source, 10000 + 6 * 3600)).toBe(false)
  expect(sourceNeedsAction(source, 10001 + 6 * 3600)).toBe(true)
})

it('renders Needs sign-in in Spanish on the source row', async () => {
  setup(youtube({ health: { state: 'broken', kind: 'auth-required', since: now() - 60 } }))
  expect(await screen.findByText('Necesita iniciar sesión')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Probar ahora' })).not.toBeInTheDocument()
})

it('labels library imports without fixing the audio source to YouTube', async () => {
  await i18n.changeLanguage('en')
  setup(youtube(), 'biblioteca')
  expect(await screen.findByText('Spotify · audio sources')).toBeVisible()
})
