import { afterEach, expect, it, vi } from 'vitest'
import { bridge } from '../bridge'
import type { IpcEventPayload } from '../lib/ipc'
import { installTauriBridge } from './tauri'

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }))
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

it('forwards both view:command payloads through the Tauri adapter and releases the listener', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {})
  native.invoke.mockResolvedValue({})
  const unlisten = vi.fn()
  let deliver!: (event: { payload: IpcEventPayload<'view:command'> }) => void
  native.listen.mockImplementation(async (_channel, listener) => { deliver = listener; return unlisten })
  await installTauriBridge()
  native.listen.mockClear()
  const changed = vi.fn()
  const stop = bridge().on('view:command', changed)
  await Promise.resolve()
  expect(native.listen).toHaveBeenCalledExactlyOnceWith('view:command', expect.any(Function))
  deliver({ payload: 'toggle-sidebar' })
  deliver({ payload: 'toggle-side-column' })
  expect(changed.mock.calls).toEqual([['toggle-sidebar'], ['toggle-side-column']])
  stop()
  expect(unlisten).toHaveBeenCalledOnce()
})
