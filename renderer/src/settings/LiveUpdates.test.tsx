import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import i18n from '../i18n'
import type { ServerStream } from '../lib/ipc'
import { setStreamState } from '../data/streamState'
import { LiveUpdatesLost, LiveUpdatesRow } from './LiveUpdates'

const at = new Date(2026, 10, 13, 14, 31).getTime()
beforeEach(async () => {
  await i18n.changeLanguage('en')
  vi.useFakeTimers()
  vi.setSystemTime(at)
  setStreamState({ state: 'connected', since: at })
})
afterEach(async () => {
  vi.useRealTimers()
  setStreamState({ state: 'auth', since: Date.now() })
  await i18n.changeLanguage('es')
})
function transition(state: ServerStream['state'], since = Date.now()) {
  act(() => setStreamState({ state, since }))
}
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms))

it.each([
  ['connected', 'Connected', 'since 14:31'],
  ['lost', 'Reconnecting', 'since 14:31'],
  ['connecting', 'Reconnecting', 'since 14:31'],
  ['auth', 'Signed out', null],
] as const)('shows the %s state with a dot and the correct time', (state, word, sub) => {
  setStreamState({ state, since: at })
  const view = render(<LiveUpdatesRow />)
  expect(screen.getByText(word)).toBeVisible()
  expect(screen.getByText(word).querySelector('.settings-dotw')).not.toBeNull()
  expect(screen.getByTitle('Changes on the nest reach this app as they happen')).toBeVisible()
  if (sub) expect(screen.getByText(sub)).toBeVisible()
  else expect(view.container).not.toHaveTextContent('since')
})

it('waits a full second after loss, cannot be dismissed, and clears on reconnect', () => {
  render(<LiveUpdatesLost />)
  expect(screen.queryByText('Live updates lost')).not.toBeInTheDocument()
  transition('lost')
  advance(999)
  expect(screen.queryByText('Live updates lost')).not.toBeInTheDocument()
  advance(1)
  expect(screen.getByRole('status')).toHaveTextContent('Live updates lost')
  expect(screen.getByTitle('Live updates lost at 14:31 · reconnecting')).toBeVisible()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  transition('connected')
  expect(screen.queryByText('Live updates lost')).not.toBeInTheDocument()
  advance(5000)
  expect(screen.queryByText('Live updates lost')).not.toBeInTheDocument()
})

it('cancels a quick blip and gives a later loss its own full delay', () => {
  render(<LiveUpdatesLost />)
  transition('lost')
  advance(500)
  transition('connected')
  advance(1000)
  expect(screen.queryByText('Live updates lost')).not.toBeInTheDocument()
  transition('lost')
  advance(999)
  expect(screen.queryByText('Live updates lost')).not.toBeInTheDocument()
  advance(1)
  expect(screen.getByText('Live updates lost')).toBeVisible()
  transition('auth')
  expect(screen.queryByText('Live updates lost')).not.toBeInTheDocument()
})

it('keeps the original loss time and warning across native retry attempts', () => {
  render(<><LiveUpdatesRow /><LiveUpdatesLost /></>)
  transition('lost')
  advance(500)
  transition('connecting')
  advance(499)
  expect(screen.queryByText('Live updates lost')).not.toBeInTheDocument()
  advance(1)
  expect(screen.getByText('Live updates lost')).toBeVisible()
  advance(60_000)
  transition('lost')
  expect(screen.getByText('Live updates lost')).toBeVisible()
  expect(screen.getByText('since 14:31')).toBeVisible()
  transition('connecting')
  expect(screen.getByText('Live updates lost')).toBeVisible()
  transition('connected')
  expect(screen.queryByText('Live updates lost')).not.toBeInTheDocument()
})

it('uses the loss time when mounted partway through an outage and cancels on unmount', () => {
  setStreamState({ state: 'lost', since: at - 750 })
  const view = render(<LiveUpdatesLost />)
  advance(249)
  expect(screen.queryByText('Live updates lost')).not.toBeInTheDocument()
  advance(1)
  expect(screen.getByText('Live updates lost')).toBeVisible()
  transition('connected')
  transition('lost')
  view.unmount()
  expect(vi.getTimerCount()).toBe(0)
})
