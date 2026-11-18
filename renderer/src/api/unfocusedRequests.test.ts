import { focusManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FakeBackend } from '../data/test-support'

let backend: FakeBackend | undefined
const originalDesktop = Object.getOwnPropertyDescriptor(window, 'desktopAPI')
beforeEach(() => {
  vi.resetModules()
  Object.defineProperty(window, 'desktopAPI', { configurable: true, value: { backendUrl: 'http://nest:8000', mediaProxyUrl: 'krobi-media://localhost' } })
})
afterEach(() => {
  focusManager.setFocused(undefined)
  backend?.restore()
  backend = undefined
  if (originalDesktop) Object.defineProperty(window, 'desktopAPI', originalDesktop)
  else Reflect.deleteProperty(window, 'desktopAPI')
})

describe('requests while the main window is unfocused', () => {
  it('sends a player-initiated GET (replaygain) immediately: quiet applies to scheduled polls only', async () => {
    const { installFakeBackend } = await import('../data/test-support')
    backend = installFakeBackend({ origin: 'http://nest:8000', respond: () => ({ status: 200, json: { trackGain: -6.2, trackPeak: 0.98 } }) })
    const { apiGet } = await import('../data/http')
    focusManager.setFocused(false)
    const answer = apiGet('/api/analysis/{album}/{file}/replaygain', { params: { path: { album: 'Album', file: 'song.mp3' } } })
    const settled = await Promise.race([answer.then(() => 'answered'), new Promise(resolve => setTimeout(() => resolve('parked'), 200))])
    expect(settled).toBe('answered')
    expect(backend.requests.map(r => new URL(r.url).pathname)).toEqual(['/api/analysis/Album/song.mp3/replaygain'])
  })
})
