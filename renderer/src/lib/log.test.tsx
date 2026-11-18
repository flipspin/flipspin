import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { setFakeBridgeForTest } from '../bridge'
import type { KrobiBridge } from './ipc'
import { formatLogValue, log, pluginLogger, reportError } from './log'
import { dismissAllNotifications, NotificationsProvider } from '../ui/notifications'

let restore: (() => void) | undefined
afterEach(() => { restore?.(); dismissAllNotifications(); vi.restoreAllMocks() })
function capture() {
  const invoke = vi.fn().mockResolvedValue(undefined)
  restore = setFakeBridgeForTest({ invoke, on: () => () => undefined } as KrobiBridge)
  return invoke
}
it('formats errors, stacks, objects, cycles, bigint and hostile values as one safe line', () => {
  const cyclic: Record<string, unknown> = { n: 3n, error: new Error('broken\nagain') }
  cyclic.self = cyclic
  const line = formatLogValue(cyclic)
  expect(line).toContain('broken')
  expect(line).toContain('stack')
  expect(line).toContain('[Circular]')
  expect(line).not.toMatch(/[\r\n\u2028\u2029]/)
  expect(formatLogValue('a\n\r\x1bb')).toBe('a   b')
  expect(formatLogValue({ toJSON() { throw new Error('no') } })).toBe('[Unserializable]')
})
it('forwards fixed scopes and keeps the host plugin prefix ahead of untrusted text', () => {
  const invoke = capture()
  log.playback.debug('started', { item: 'song' })
  pluginLogger('example').info('[plugin:other]\nhello')
  expect(invoke.mock.calls).toEqual([
    ['log:write', { level: 'debug', message: '[playback] started {"item":"song"}' }],
    ['log:write', { level: 'info', message: '[plugin:example] [plugin:other] hello' }],
  ])
})
it('logs the full failure exactly once and toasts at most 100 message characters without a stack', () => {
  const invoke = capture()
  render(<NotificationsProvider />)
  const error = new Error('x'.repeat(150) + '\nat hidden (file.ts:1)')
  act(() => reportError('downloads', { userMessage: 'No se pudo descargar', error }))
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(invoke.mock.calls[0][1].message).toContain('stack')
  expect(invoke.mock.calls[0][1].message).toContain('hidden')
  expect(screen.getByText('No se pudo descargar')).toBeVisible()
  expect(screen.getByText('x'.repeat(100))).toBeVisible()
  expect(screen.queryByText(/hidden/)).toBeNull()
})
it('handles a string stack and an unavailable bridge without rejecting', async () => {
  const invoke = capture().mockRejectedValue(new Error('bridge unavailable'))
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  render(<NotificationsProvider />)
  act(() => reportError('app', { userMessage: 'Falló', error: 'reason\n at secret.ts:1' }))
  await act(async () => {})
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(screen.getByText('reason')).toBeVisible()
  expect(screen.queryByText(/secret.ts/)).toBeNull()
})
