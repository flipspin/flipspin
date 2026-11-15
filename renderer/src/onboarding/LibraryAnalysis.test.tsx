import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, expect, it } from 'vitest'
import i18n from '../i18n'
import { DataProvider } from '../data'
import { installFakeSettings, type FakeSettings } from '../settings/test-support'
import { LibraryAnalysis } from './LibraryAnalysis'

let fake: FakeSettings
let client: QueryClient
afterEach(async () => { fake?.restore(); client?.clear(); await i18n.changeLanguage('es') })
async function setup(outdated?: number, size = 2) {
  await i18n.changeLanguage('en')
  fake = installFakeSettings({ respond: r => {
    if (r.pathname === '/api/analysis/summary') return { status: 200, json: { total: 2, analyzed: 0, outdated, queued: 0, failed: 0 } }
    if (r.pathname === '/api/analysis/runs/preview') return { status: 200, json: { size } }
    if (r.pathname === '/api/analysis/runs') return { status: 200, json: {} }
    return undefined
  } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<DataProvider queryClient={client}><LibraryAnalysis /></DataProvider>)
}
it('shows older-engine status next to Analyse now and explicitly requests re-analysis', async () => {
  await setup(2)
  const status = await screen.findByTitle('2 songs analysed by an older engine')
  expect(status).toHaveTextContent('Analysis · Outdated')
  expect(status).toHaveAttribute('role', 'status')
  expect(status.querySelector('i')).toHaveAttribute('aria-hidden', 'true')
  await userEvent.click(screen.getByRole('button', { name: 'Analyse now' }))
  await waitFor(() => expect(fake.requests.find(r => r.pathname === '/api/analysis/runs')?.body).toMatchObject({ mode: 'outdated', scope: 'library' }))
  expect(await screen.findByText('Started')).toBeVisible()
})
it.each([0, undefined])('hides outdated status for current or older-server summaries (%s)', async outdated => {
  await setup(outdated)
  await screen.findByText('Not started')
  expect(screen.queryByText('Outdated')).not.toBeInTheDocument()
})
it('keeps older-engine status visible even if a stale preview reports no work', async () => {
  await setup(1, 0)
  expect(await screen.findByTitle('1 songs analysed by an older engine')).toHaveTextContent('Outdated')
  expect(screen.getByRole('button', { name: 'Analyse now' })).toBeEnabled()
})
