import { configure, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it } from 'vitest'
import i18n from '../i18n'
import { type Provider } from './data'
import { renderPage } from './page-test-support'

configure({ asyncUtilTimeout: 5000 })

const extension = { id: 'youtube', kind: 'source', name: 'YouTube', version: '1.1.1', state: 'on', reason: 'Ready' }
const youtube = (overrides: Partial<Provider> = {}): Provider => ({
  id: 'youtube', kind: 'streaming', name: 'YouTube', enabled: true, position: 0, available: true,
  requiresCredentials: false, capabilities: ['stream'], unavailableReason: null, health: { state: 'ok' }, format: null,
  status: { revision: 'one', facts: [{ label: 'Format', value: 'AAC · m4a' }], actions: [], toggles: [] },
  ...overrides,
})

function setup(section: string, source: Provider = youtube()) {
  let provider = source
  return renderPage({ section, respond: request => {
    if (request.pathname === '/api/extensions') return { status: 200, json: { extensions: [extension], accepted: {} } }
    if (request.pathname === '/api/providers') return { status: 200, json: { providers: [provider] } }
    if (request.pathname === '/api/sources/known') return { status: 200, json: { sources: [{ id: 'youtube', name: 'YouTube', facts: [], location: 'x', installed: true }] } }
    if (request.pathname === '/api/providers/youtube' && request.method === 'PUT') {
      provider = { ...provider, enabled: (request.body as { enabled: boolean }).enabled }
      return { status: 200, json: provider }
    }
    return undefined
  } })
}

beforeEach(async () => { await i18n.changeLanguage('en') })

it('gives an installed source plugin its own card holding all of its controls', async () => {
  const { fake } = setup('plugins')
  const card = await screen.findByRole('region', { name: 'YouTube' })
  expect(within(card).getByText('1.1.1')).toBeInTheDocument()
  expect(within(card).getByRole('button', { name: 'Update' })).toBeInTheDocument()
  expect(within(card).getByRole('button', { name: 'Remove' })).toBeInTheDocument()
  const toggle = await within(card).findByRole('switch', { name: 'YouTube' })
  await userEvent.click(toggle)
  await waitFor(() => expect(fake.requests.find(request => request.pathname === '/api/providers/youtube' && request.method === 'PUT')?.body).toEqual({ enabled: false }))
  await userEvent.click(within(card).getByRole('button', { name: 'Open' }))
  expect(await within(card).findByText('AAC · m4a')).toBeInTheDocument()
  // The add card no longer carries an installed plugin's row.
  const add = screen.getByText('Add a plugin').closest('.settings-block') as HTMLElement
  expect(within(add).queryByText('YouTube')).toBeNull()
}, 15_000)

it('lists the installed plugin under Plugins in the menu and opens only its card', async () => {
  setup('plugins')
  const menu = screen.getByRole('navigation', { name: 'Settings sections' })
  const branch = within(menu).getByRole('button', { name: 'Show or hide Plugins' })
  if (branch.getAttribute('aria-expanded') !== 'true') await userEvent.click(branch)
  await userEvent.click(await within(menu).findByRole('button', { name: 'YouTube' }))
  expect(await screen.findByRole('region', { name: 'YouTube' })).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Ties' })).toBeNull()
  expect(screen.queryByText('Add a plugin')).toBeNull()
}, 15_000)

it('keeps only the order on the Audio source page and links the plugin to its card', async () => {
  setup('sources-audio', youtube({ health: { state: 'broken', kind: 'broken', until: Date.now() / 1000 + 600 } }))
  const link = await screen.findByRole('button', { name: 'YouTube' })
  expect(screen.queryByRole('switch', { name: 'YouTube' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Try now' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Move YouTube up' })).toBeInTheDocument()
  await userEvent.click(link)
  const card = await screen.findByRole('region', { name: 'YouTube' })
  expect(within(card).getByRole('button', { name: 'Try now' })).toBeInTheDocument()
})
