import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { SchemaLibraryScanStatus } from '../api/generated/schema'
import i18n from '../i18n'
import { LibraryWatchRow } from './LibraryWatch'
import { libraryScanKey } from './libraryScansData'

let client: QueryClient
beforeEach(async () => {
  await i18n.changeLanguage('en')
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
})
afterEach(async () => { client.clear(); await i18n.changeLanguage('es') })
const status: SchemaLibraryScanStatus = { watching: true, intervalSeconds: 1800, scanning: false, pending: false, lastScanAt: null, durationSeconds: null, error: null }

it.each([
  [true, 1800, 'Watching', 'full check every 30 min'],
  [false, 300, 'Not watching', 'every 5 min'],
  [true, 300, 'Watching', 'full check every 5 min'],
  [false, 1800, 'Not watching', 'every 30 min'],
])('uses watcher=%s and interval=%s from status', (watching, intervalSeconds, word, interval) => {
  client.setQueryData(libraryScanKey, { ...status, watching, intervalSeconds })
  render(<QueryClientProvider client={client}><LibraryWatchRow /></QueryClientProvider>)
  expect(screen.getByText('Library watch')).toBeVisible()
  expect(screen.getByText(word)).toBeVisible()
  expect(screen.getByText(interval)).toBeVisible()
})

it('updates when scan status changes and keeps the reason in a tooltip', async () => {
  client.setQueryData(libraryScanKey, status)
  render(<QueryClientProvider client={client}><LibraryWatchRow /></QueryClientProvider>)
  await act(async () => {
    client.setQueryData(libraryScanKey, { ...status, watching: false, intervalSeconds: 300, error: 'unavailable' })
  })
  expect(await screen.findByText('Not watching')).toHaveAttribute('title', 'Folder unavailable')
  expect(screen.getByText('every 5 min')).toBeVisible()
  expect(screen.queryByText('Folder unavailable')).not.toBeInTheDocument()
})
