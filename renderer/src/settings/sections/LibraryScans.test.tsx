import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { DataProvider } from '../../data'
import { installFakeSettings, type FakeSettings } from '../test-support'
import { LibraryScans } from './LibraryScans'
import i18n from '../../i18n'

let fake: FakeSettings | undefined
let client: QueryClient | undefined
afterEach(async () => {
  fake?.restore()
  client?.clear()
  vi.restoreAllMocks()
  await i18n.changeLanguage('es')
})

const status = { watching: false, intervalSeconds: 300, scanning: false, pending: false, lastScanAt: '2026-11-12T10:00:00Z', durationSeconds: 1.25, error: null }
function setup(options: { error?: number; scanning?: boolean; commandError?: boolean; never?: boolean; watching?: boolean; intervalSeconds?: number } = {}) {
  fake = installFakeSettings({ respond: r => r.pathname === '/api/library/scan' ? {
    status: r.method === 'POST' ? options.commandError ? 500 : 202 : options.error ?? 200,
    json: options.error ? { detail: 'Not Found' } : { ...status, watching: options.watching ?? false, intervalSeconds: options.intervalSeconds ?? 300, lastScanAt: options.never ? null : status.lastScanAt, durationSeconds: options.never ? null : status.durationSeconds, scanning: options.scanning ?? false },
  } : undefined })
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<DataProvider queryClient={client}><LibraryScans /></DataProvider>)
  return fake
}

it('shows the last scan time and duration, with both actions in English', async () => {
  await i18n.changeLanguage('en')
  setup()
  expect(await screen.findByText('Last scan', {}, { timeout: 10_000 })).toBeVisible()
  expect(document.querySelector('time')).toHaveAttribute('dateTime', status.lastScanAt)
  expect(screen.getByText(/1.25 s/)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Scan for changes' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Full rescan' })).toBeEnabled()
  expect(screen.getByText('every 5 min')).toBeVisible()
})

it('uses the reported full-check interval alongside the watcher', async () => {
  await i18n.changeLanguage('en')
  setup({ watching: true, intervalSeconds: 1800 })
  expect(await screen.findByText('Watching for changes · full check every 30 min')).toBeVisible()
})

it.each([false, true])('enqueues a %s full scan instead of refetching the summary', async full => {
  const requests = setup()
  await userEvent.click(await screen.findByRole('button', { name: full ? 'Escaneo completo' : 'Buscar cambios' }))
  await waitFor(() => expect(requests.requests.some(r => r.method === 'POST')).toBe(true))
  expect(requests.requests.find(r => r.method === 'POST')?.body).toEqual({ full })
  expect(requests.requests.some(r => r.pathname === '/api/library/summary')).toBe(false)
})

it('disables both buttons while a scan runs', async () => {
  setup({ scanning: true })
  expect(await screen.findByText('Escaneando…')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Buscar cambios' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Escaneo completo' })).toBeDisabled()
})

it('shows a word for a scan that has never run', async () => {
  setup({ never: true })
  expect(await screen.findByText('Nunca')).toBeVisible()
  expect(document.querySelector('time')).toBeNull()
})

it('shows an older nest note', async () => {
  setup({ error: 404 })
  expect(await screen.findByText('Actualiza el nido para escanear la biblioteca.')).toBeVisible()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

it('shows a failed command and permits retry', async () => {
  setup({ commandError: true })
  await userEvent.click(await screen.findByRole('button', { name: 'Buscar cambios' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo iniciar el escaneo')
  expect(screen.getByRole('button', { name: 'Buscar cambios' })).toBeEnabled()
})

it('refreshes library queries when the first scan finishes', async () => {
  setup({ never: true })
  await screen.findByText('Nunca')
  const invalidate = vi.spyOn(client!, 'invalidateQueries')
  client!.setQueryData(['library', 'scan'], status)
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['library'] }))
})
