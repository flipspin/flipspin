import { afterEach, expect, it, vi } from 'vitest'
import { bridge } from '../bridge'
import { installTauriBridge } from './tauri'

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  deliver: undefined as ((event: { payload: boolean }) => void) | undefined,
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); native.deliver = undefined })

async function install(focused: boolean) {
  vi.stubGlobal('__TAURI_INTERNALS__', {})
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'desktop_bootstrap') return {}
    if (args?.channel === 'window:get-focus') return focused
    return undefined
  })
  native.listen.mockImplementation(async (_event, listener) => { native.deliver = listener; return vi.fn() })
  await installTauriBridge()
}

it('adapts the typed main-window focus event and supplies initial native focus', async () => {
  await install(false)
  const changed = vi.fn()
  const stop = bridge().on('window:focus', changed)
  expect(changed).toHaveBeenLastCalledWith(false)
  await Promise.resolve(); await Promise.resolve()
  expect(native.listen).toHaveBeenCalledWith('window:focus', expect.any(Function))
  native.deliver?.({ payload: true })
  native.deliver?.({ payload: false })
  expect(changed.mock.calls.slice(-2)).toEqual([[true], [false]])
  stop()

  // A later subscriber must ignore a snapshot overtaken by a native blur.
  let finish!: (value: boolean) => void
  native.invoke.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve }))
  changed.mockClear()
  const stopAgain = bridge().on('window:focus', changed)
  await Promise.resolve()
  native.deliver?.({ payload: false })
  finish(true)
  await Promise.resolve(); await Promise.resolve()
  expect(changed).toHaveBeenLastCalledWith(false)
  stopAgain()
  native.deliver?.({ payload: true })
  expect(changed).toHaveBeenLastCalledWith(false)
})
