import { afterEach, expect, it, vi } from 'vitest'
import { bridge } from '../bridge'
import { installTauriBridge } from './tauri'

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it('registers every stream listener before reading the shell snapshot', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {})
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'desktop_bootstrap') return {}
    if (args?.channel === 'window:get-focus') return true
    return { hello: null, stream: { state: 'connecting', since: 1 } }
  })
  native.listen.mockResolvedValue(vi.fn())
  await installTauriBridge()
  const pending: Array<(stop: () => void) => void> = []
  const deliver = new Map<string, (event: { payload: unknown }) => void>()
  native.listen.mockImplementation((channel, listener) => {
    deliver.set(channel, listener)
    return new Promise(resolve => { pending.push(resolve) })
  })
  const changed = vi.fn()
  const stops = [
    bridge().on('server:changed', changed),
    bridge().on('server:hello', vi.fn()),
    bridge().on('server:stream', vi.fn()),
  ]
  native.invoke.mockClear()
  const snapshot = bridge().invoke('server:stream-snapshot', undefined)
  await Promise.resolve()
  expect(native.invoke).not.toHaveBeenCalled()
  const unlisten = vi.fn()
  pending[0](unlisten); pending[1](unlisten)
  await Promise.resolve(); await Promise.resolve()
  expect(native.invoke).not.toHaveBeenCalled()
  pending[2](unlisten)
  await snapshot
  expect(native.invoke).toHaveBeenCalledWith('bridge_invoke', { channel: 'server:stream-snapshot', request: null })
  deliver.get('server:changed')?.({ payload: { area: 'library', rev: 1 } })
  expect(changed).toHaveBeenCalledTimes(1)
  stops.forEach(stop => stop())
  expect(unlisten).toHaveBeenCalledTimes(3)
  deliver.get('server:changed')?.({ payload: { area: 'library', rev: 2 } })
  expect(changed).toHaveBeenCalledTimes(1)
})
