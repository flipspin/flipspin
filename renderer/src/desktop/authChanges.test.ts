import { afterEach, expect, it, vi } from 'vitest'
import { installTauriBridge } from './tauri'

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }))

const frames: HTMLIFrameElement[] = []

function nextWindow() {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  frames.push(frame)
  vi.stubGlobal('window', frame.contentWindow!)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
  vi.clearAllMocks()
  for (const frame of frames.splice(0)) frame.remove()
})

it('refreshes main and player credentials through auth:get after secret-free events', async () => {
  vi.stubGlobal('__TAURI_INTERNALS__', {})
  let token = 'initial-secret'
  const events = new Map<string, Array<(event: { payload: unknown }) => void>>()
  native.listen.mockImplementation(async (channel, listener) => {
    events.set(channel, [...events.get(channel) || [], listener])
    return vi.fn()
  })
  native.invoke.mockImplementation(async (command, args) => {
    if (command === 'desktop_bootstrap') return { backendToken: token }
    if (args?.channel === 'auth:get') return { token, hasToken: Boolean(token) }
    return false
  })
  nextWindow()
  await installTauriBridge()
  const main = await import('../lib/authToken')
  const compat = vi.fn()
  window.desktopAPI!.onAuthChanged(compat)
  vi.resetModules()
  nextWindow()
  await installTauriBridge()
  const player = await import('../lib/authToken')
  await vi.waitFor(() => expect(player.getApiToken()).toBe('initial-secret'))
  const mainChanged = vi.fn()
  const playerChanged = vi.fn()
  main.subscribeToken(mainChanged)
  player.subscribeToken(playerChanged)

  for (const next of ['rotated-secret', '']) {
    token = next
    const before = native.invoke.mock.calls.filter(([, args]) => args?.channel === 'auth:get').length
    const notice = { changed: true }
    for (const listener of events.get('auth-changed') || []) listener({ payload: notice })
    await vi.waitFor(() => {
      expect(main.getApiToken()).toBe(next)
      expect(player.getApiToken()).toBe(next)
    })
    expect(mainChanged).toHaveBeenLastCalledWith(next)
    expect(playerChanged).toHaveBeenLastCalledWith(next)
    expect(compat).toHaveBeenLastCalledWith({ changed: true })
    expect(native.invoke.mock.calls.filter(([, args]) => args?.channel === 'auth:get')).toHaveLength(before + 2)
  }

  // A delayed old auth:get must not overwrite a newer sign-out response.
  const replies: Array<(auth: { token: string }) => void> = []
  native.invoke.mockImplementation((_command, args) => args?.channel === 'auth:get'
    ? new Promise(resolve => { replies.push(resolve) }) : Promise.resolve(false))
  for (const listener of events.get('auth-changed') || []) listener({ payload: { changed: true } })
  for (const listener of events.get('auth-changed') || []) listener({ payload: { changed: true } })
  replies[2]({ token: 'latest-secret' })
  replies[3]({ token: 'latest-secret' })
  await vi.waitFor(() => expect(main.getApiToken()).toBe('latest-secret'))
  replies[0]({ token: 'stale-secret' })
  replies[1]({ token: 'stale-secret' })
  await Promise.resolve()
  expect(main.getApiToken()).toBe('latest-secret')
  expect(player.getApiToken()).toBe('latest-secret')
})
