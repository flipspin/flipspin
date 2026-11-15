import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import i18n from '../i18n'
import { closePluginInstaller } from './sourceInstaller'
import { renderPage } from './page-test-support'

const source = { id: 'fake', kind: 'source', name: 'Fake', version: '1.0.0', state: 'on', reason: 'Ready' }
afterEach(closePluginInstaller)

const knownSource = { id: 'youtube', name: 'YouTube', facts: ['Songs', 'AAC', 'm4a', 'official'], location: 'https://example.test/source.git', installed: false }

async function openSheet() {
  await userEvent.click(await screen.findByRole('button', { name: 'Add' }))
  return screen.getByRole('dialog', { name: 'Add a plugin' })
}

it('keeps Other source closed, then submits a server folder and shows a plain failure', async () => {
  await i18n.changeLanguage('en')
  const { fake } = renderPage({ section: 'plugins', respond: request => {
    if (request.pathname === '/api/sources/known') return { status: 200, json: { sources: [knownSource] } }
    if (request.pathname === '/api/sources/install') return { status: 200, json: { progress_id: 'install-1' } }
    if (request.pathname === '/api/jobs') return { status: 200, json: { jobs: [{ id: 'install-1', kind: 'source-install', state: 'failed', percent: 100, endedAt: 1, failed: 1 }], degraded: [] } }
    if (request.pathname === '/api/jobs/install-1/items') return { status: 200, json: { items: [{ state: 'failed', reason: 'invalid', detail: { error: 'Invalid manifest: entry.command' } }] } }
  } })
  const sheet = await openSheet()
  expect(within(sheet).getByText('Other source').closest('details')).not.toHaveAttribute('open')
  await userEvent.click(within(sheet).getByText('Other source'))
  await userEvent.type(within(sheet).getByRole('textbox'), '/plugins/fake')
  const form = within(sheet).getByRole('textbox').closest('form')!
  await userEvent.click(within(form).getByRole('button', { name: 'Install' }))
  expect(await within(form).findByRole('alert')).toHaveTextContent("The server couldn't install the source.")
  await waitFor(() => expect(within(form).getByRole('alert')).toHaveAttribute('title', 'Invalid manifest: entry.command'))
  expect(within(form).queryByRole('progressbar')).not.toBeInTheDocument()
  expect(within(form).getByRole('alert')).not.toHaveClass('z-err')
  expect(fake.requests.find(request => request.pathname === '/api/sources/install')?.body).toEqual({ location: '/plugins/fake' })
})

it('shows source metadata and confirms Remove before deleting', async () => {
  await i18n.changeLanguage('en')
  let installed = true
  const { fake } = renderPage({ section: 'plugins', respond: request => {
    if (request.pathname === '/api/extensions') return { status: 200, json: { extensions: installed ? [source] : [], accepted: {} } }
    if (request.pathname === '/api/sources/fake' && request.method === 'DELETE') { installed = false; return { status: 200, json: { removed: true } } }
  } })
  expect(await screen.findByText('Fake')).toBeVisible()
  expect(screen.getByText('1.0.0')).toBeVisible()
  expect(screen.getByText('On')).toHaveAttribute('title', 'Ready')
  await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
  expect(fake.requests.some(request => request.method === 'DELETE')).toBe(false)
  await userEvent.click(within(screen.getByRole('dialog', { name: 'Remove Fake' })).getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(screen.queryByText('Fake')).not.toBeInTheDocument())
})

it('installs from the Overview to-do without a field and retains progress in the sheet', async () => {
  await i18n.changeLanguage('en')
  const { fake } = renderPage({ section: 'resumen', respond: request => {
    if (request.pathname === '/api/sources/known') return { status: 200, json: { sources: [knownSource] } }
    if (request.pathname === '/api/sources/install') return { status: 200, json: { progress_id: 'install-1' } }
    if (request.pathname === '/api/jobs') return { status: 200, json: { jobs: [{ id: 'install-1', state: 'running', endedAt: null, phase: 'build' }], degraded: [] } }
  } })
  const todo = (await screen.findByText('Install the YouTube source')).closest<HTMLElement>('.settings-source')!
  expect(within(todo).getByText('No source can download songs yet')).toBeVisible()
  expect(within(todo).queryByRole('textbox')).not.toBeInTheDocument()
  await userEvent.click(within(todo).getByRole('button', { name: 'Install' }))
  expect(await within(todo).findByText('Setting up · 2 of 3')).toBeVisible()
  expect(fake.requests.find(request => request.pathname === '/api/sources/install')?.body).toEqual({ id: 'youtube' })
  await userEvent.click(screen.getByRole('button', { name: 'Plugins' }))
  const sheet = await openSheet()
  expect(await within(sheet).findByText('Setting up · 2 of 3')).toBeVisible()
  expect(fake.requests.filter(request => request.pathname === '/api/sources/install')).toHaveLength(1)
})

it('closes the installer through the shared sheet and restores Add focus', async () => {
  await i18n.changeLanguage('en')
  renderPage({ section: 'plugins' })
  const add = await screen.findByRole('button', { name: 'Add' })
  await userEvent.click(add)
  expect(screen.getByRole('dialog', { name: 'Add a plugin' })).toBeVisible()
  await userEvent.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add a plugin' })).not.toBeInTheDocument())
  await waitFor(() => expect(add).toHaveFocus())
})

it('renders catalog metadata and an installed row with no Install button', async () => {
  await i18n.changeLanguage('en')
  renderPage({ section: 'plugins', respond: request => {
    if (request.pathname === '/api/sources/known') return { status: 200, json: { sources: [{ ...knownSource, id: 'another', name: 'Another source', installed: true }] } }
  } })
  const sheet = await openSheet()
  expect(await within(sheet).findByText('Another source')).toBeVisible()
  expect(within(sheet).getByText('Songs · AAC · m4a · official')).toBeVisible()
  expect(within(sheet).getByText('Installed').querySelector('.settings-dotw--ok')).toBeInTheDocument()
  expect(within(within(sheet).getByText('Installed').closest<HTMLElement>('.settings-source')!).queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
})

it.each([
  ['fetch', 'Downloading · 1 of 3', 1], ['validate', 'Setting up · 2 of 3', 2], ['build', 'Setting up · 2 of 3', 2],
  ['hello', 'Checking · 3 of 3', 3], ['test', 'Checking · 3 of 3', 3], ['publish', 'Checking · 3 of 3', 3],
])('uses the job phase %s for the row meter and count', async (phase, word, step) => {
  await i18n.changeLanguage('en')
  const { fake } = renderPage({ section: 'plugins', respond: request => {
    if (request.pathname === '/api/sources/known') return { status: 200, json: { sources: [knownSource] } }
    if (request.pathname === '/api/sources/install') return { status: 200, json: { progress_id: 'install-1' } }
    if (request.pathname === '/api/jobs') return { status: 200, json: { jobs: [{ id: 'install-1', state: 'running', endedAt: null, phase }], degraded: [] } }
  } })
  const sheet = await openSheet()
  const row = (await within(sheet).findByText('YouTube')).closest<HTMLElement>('.settings-source')!
  await userEvent.click(within(row).getByRole('button', { name: 'Install' }))
  expect(await within(sheet).findByText(word)).toBeVisible()
  expect(within(sheet).getByRole('progressbar')).toHaveAttribute('aria-valuenow', String(step))
  expect(within(row).queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
  expect(fake.requests.find(request => request.pathname === '/api/sources/install')?.body).toEqual({ id: 'youtube' })
})

it('replaces a failed full job meter with a dot, sentence and Retry, then Installed', async () => {
  await i18n.changeLanguage('en')
  let attempt = 0
  const { fake } = renderPage({ section: 'plugins', respond: request => {
    if (request.pathname === '/api/sources/known') return { status: 200, json: { sources: [knownSource] } }
    if (request.pathname === '/api/sources/install') return { status: 200, json: { progress_id: `install-${++attempt}` } }
    if (request.pathname === '/api/jobs') return { status: 200, json: { jobs: [{ id: `install-${attempt}`, state: attempt === 1 ? 'failed' : 'succeeded', endedAt: 1, percent: 100, failed: attempt === 1 ? 1 : 0 }], degraded: [] } }
    if (request.pathname === '/api/jobs/install-1/items') return { status: 200, json: { items: [{ state: 'failed', detail: { error: 'fatal: unable to access github.com: Could not resolve host' } }] } }
  } })
  const sheet = await openSheet()
  const row = (await within(sheet).findByText('YouTube')).closest<HTMLElement>('.settings-source')!
  await userEvent.click(within(row).getByRole('button', { name: 'Install' }))
  expect(await within(sheet).findByText("The server couldn't reach GitHub.")).toHaveAttribute('title', 'fatal: unable to access github.com: Could not resolve host')
  expect(within(sheet).queryByRole('progressbar')).not.toBeInTheDocument()
  expect(within(sheet).getByText('Failed').querySelector('.settings-dotw--bad')).toBeInTheDocument()
  await userEvent.click(within(sheet).getByRole('button', { name: 'Retry' }))
  expect(await within(sheet).findByText('Installed')).toBeVisible()
  expect(within(row).queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
  expect(within(sheet).queryByRole('progressbar')).not.toBeInTheDocument()
  expect(fake.requests.filter(request => request.pathname === '/api/sources/install')).toHaveLength(2)
})

it.each(['youtube', 'YoUtUbE'])('resolves the short name %s in Other source', async name => {
  await i18n.changeLanguage('en')
  const { fake } = renderPage({ section: 'plugins', respond: request => {
    if (request.pathname === '/api/sources/known') return { status: 200, json: { sources: [knownSource] } }
    if (request.pathname === '/api/sources/install') return { status: 200, json: { progress_id: 'install-1' } }
    if (request.pathname === '/api/jobs') return { status: 200, json: { jobs: [{ id: 'install-1', state: 'succeeded', endedAt: 1 }], degraded: [] } }
  } })
  const sheet = await openSheet()
  await within(sheet).findByText('YouTube')
  await userEvent.click(within(sheet).getByText('Other source'))
  await userEvent.type(within(sheet).getByRole('textbox'), name)
  expect(within(sheet).getByText('Installs the YouTube source above')).toBeVisible()
  const form = within(sheet).getByRole('textbox').closest('form')!
  await userEvent.click(within(form).getByRole('button', { name: 'Install' }))
  await waitFor(() => expect(within(sheet).getAllByText('Installed')).toHaveLength(2))
  expect(fake.requests.find(request => request.pathname === '/api/sources/install')?.body).toEqual({ id: 'youtube' })
})

it.each(['failed', 'succeeded'])('shows the %s outcome in the Overview to-do without a field', async outcome => {
  await i18n.changeLanguage('en')
  renderPage({ section: 'resumen', respond: request => {
    if (request.pathname === '/api/sources/known') return { status: 200, json: { sources: [knownSource] } }
    if (request.pathname === '/api/sources/install') return { status: 200, json: { progress_id: 'install-1' } }
    if (request.pathname === '/api/jobs') return { status: 200, json: { jobs: [{ id: 'install-1', state: outcome, endedAt: 1, percent: 100, failed: outcome === 'failed' ? 1 : 0 }], degraded: [] } }
  } })
  const todo = (await screen.findByText('Install the YouTube source')).closest<HTMLElement>('.settings-source')!
  await userEvent.click(within(todo).getByRole('button', { name: 'Install' }))
  expect(await within(todo).findByText(outcome === 'failed' ? 'Failed' : 'Installed')).toBeVisible()
  expect(within(todo).queryByRole('progressbar')).not.toBeInTheDocument()
  expect(within(todo).queryByRole('textbox')).not.toBeInTheDocument()
  expect(within(todo).queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
  if (outcome === 'failed') expect(within(todo).getByRole('button', { name: 'Retry' })).toBeVisible()
})

it('shows an immediate install request failure with Retry and no meter', async () => {
  await i18n.changeLanguage('en')
  renderPage({ section: 'plugins', respond: request => {
    if (request.pathname === '/api/sources/known') return { status: 200, json: { sources: [knownSource] } }
    if (request.pathname === '/api/sources/install') return { status: 503, json: { detail: 'Service unavailable' } }
  } })
  const sheet = await openSheet()
  const row = (await within(sheet).findByText('YouTube')).closest<HTMLElement>('.settings-source')!
  await userEvent.click(within(row).getByRole('button', { name: 'Install' }))
  expect(await within(row).findByText('Failed')).toBeVisible()
  expect(within(row).getByRole('button', { name: 'Retry' })).toBeVisible()
  expect(within(row).getByRole('alert')).not.toHaveClass('z-err')
  expect(within(row).queryByRole('progressbar')).not.toBeInTheDocument()
})
