import { changeHandler } from '../data/changes'
import { afterEach, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { installFakeSettings, type FakeSettings } from '../settings/test-support'
import { useAnalysisSummary } from './data'

let fake: FakeSettings | undefined
afterEach(() => { fake?.restore(); vi.useRealTimers() })
function Summary({ owner }: { owner: boolean }) { useAnalysisSummary(owner); return null }
it('refreshes mounted owner summaries on events without an idle timer', async () => {
  vi.useFakeTimers()
  fake = installFakeSettings({ respond: () => ({ status: 200, json: { total: 1, analyzed: 0, queued: 1, failed: 0, engineVersion: 1, helper: { online: false, working: false, name: null } } }) })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const page = (owner: boolean) => <QueryClientProvider client={client}><Summary owner={owner} /></QueryClientProvider>
  const changes = changeHandler(client)
  const view = render(page(false))
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
  expect(fake.requests).toHaveLength(0)
  view.rerender(page(true))
  await act(async () => { await vi.advanceTimersByTimeAsync(100) })
  expect(fake.requests).toHaveLength(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(fake.requests).toHaveLength(1)
  changes.changed({ area: 'analysis', rev: 1 })
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  expect(fake.requests).toHaveLength(2)
  view.unmount()
  changes.changed({ area: 'analysis', rev: 2 })
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
  expect(fake.requests).toHaveLength(2)
  changes.dispose(); client.clear()
})
