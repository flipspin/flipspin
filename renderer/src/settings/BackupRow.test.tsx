import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import { queryKeys } from '../data/keys'
import { installFakeSettings, type FakeSettings, type RecordedRequest, type ResponseSpec } from './test-support'
import { useServerHost } from '../data/hooks/use-server-host'
import { BackupRow } from './BackupRow'
import { ToastProvider } from './parts'

const mode = vi.hoisted(() => ({ offline: false }))
vi.mock('../offline/useOffline', () => ({ useOffline: () => mode.offline }))

let fake: FakeSettings
let client: QueryClient
beforeEach(async () => { mode.offline = false; await i18n.changeLanguage('en') })
afterEach(async () => {
  fake?.restore()
  client?.clear()
  vi.restoreAllMocks()
  await i18n.changeLanguage('es')
})

function Row() {
  const host = useServerHost(true)
  return <dl><BackupRow host={host} /></dl>
}
function setup(at: string | null | undefined, respond?: (request: RecordedRequest) => ResponseSpec | undefined) {
  fake = installFakeSettings({ respond: r => {
    const answer = respond?.(r)
    if (answer) return answer
    if (r.pathname === '/api/server/host') return { status: 200, json: { lastBackupAt: at, lastBackupReason: 'before-bulk-tags' } }
    if (r.pathname === '/api/server/backups') return { status: 201, json: { stamp: '20261030T120000.000000Z', size: 20, reason: 'manual', ok: true } }
  } })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><ToastProvider><Row /></ToastProvider></QueryClientProvider>)
}

describe('Last backup', () => {
  it.each([[30, 'Just now'], [180, '3 min ago'], [10800, '3 h ago'], [259200, '3 d ago']])('shows a dot, compact age and reason for %s seconds', async (seconds, text) => {
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    setup(new Date(now - Number(seconds) * 1000).toISOString())
    const age = await screen.findByText(text)
    expect(screen.getByText('Last backup')).toBeInTheDocument()
    expect(age).toHaveAttribute('title', expect.stringContaining('before-bulk-tags'))
    expect(age.querySelector('.settings-dotw')).not.toBeNull()
    expect(age).toHaveClass(Number(seconds) >= 172800 ? 'settings-word--warn' : 'settings-word--ok')
  })
  it('shows Never for an explicitly absent backup', async () => {
    setup(null)
    expect(await screen.findByText('Never')).toHaveClass('settings-word--warn')
  })
  it.each([undefined, 'bad date'])('shows an unknown value for older servers or invalid dates: %s', async at => {
    setup(at)
    expect(await screen.findByText('Unavailable', { exact: false })).toBeInTheDocument()
    expect(screen.queryByText('Never')).not.toBeInTheDocument()
  })
  it('backs up once, disables the button while busy and refreshes the age', async () => {
    let created = false
    setup(null, r => {
      if (r.pathname === '/api/server/backups') { created = true; return { status: 201, json: { ok: true } } }
      if (r.pathname === '/api/server/host' && created) return { status: 200, json: { lastBackupAt: new Date().toISOString(), lastBackupReason: 'manual' } }
    })
    await screen.findByText('Never')
    fireEvent.click(screen.getByRole('button', { name: 'Back up now' }))
    expect(screen.getByRole('button', { name: 'Backing up…' })).toBeDisabled()
    expect(await screen.findByText('Backup created')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Back up now' })).toBeEnabled())
    expect(fake.requests.filter(r => r.pathname === '/api/server/backups' && r.method === 'POST')).toHaveLength(1)
    expect(client.getQueryData(queryKeys.server.host())).toMatchObject({ lastBackupReason: 'manual' })
  })
  it('disables backup while offline', async () => {
    mode.offline = true
    setup(null)
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeDisabled()
    expect(fake.requests.filter(r => r.pathname === '/api/server/backups')).toHaveLength(0)
  })
  it.each([[409, 'A backup is already running'], [503, 'Could not create backup']])('handles status %s and permits retry', async (status, message) => {
    setup(null, r => r.pathname === '/api/server/backups' ? { status: Number(status), json: { detail: 'failed' } } : undefined)
    await userEvent.click(screen.getByRole('button', { name: 'Back up now' }))
    expect(await screen.findByText(message)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back up now' })).toBeEnabled()
    expect(screen.getByText('Never')).toBeInTheDocument()
  })
})
