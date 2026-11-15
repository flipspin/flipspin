import { afterEach, describe, expect, it, vi } from 'vitest'

import { isBackendUrl, proxyFetch } from '@lib/apiAuth'

const priorDesktopApi = window.desktopAPI

afterEach(() => {
  Object.defineProperty(window, 'desktopAPI', { configurable: true, value: priorDesktopApi })
})

describe('Tauri backend fetch boundary', () => {
  it('matches only the configured origin and path boundary', () => {
    expect(isBackendUrl('http://localhost:8000/api/status')).toBe(true)
    expect(isBackendUrl('http://localhost:8000.evil.example/api/status')).toBe(false)
    expect(isBackendUrl('https://localhost:8000/api/status')).toBe(false)
  })

  it('turns a Rust proxy envelope back into a fetch Response', async () => {
    const requestBackend = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: '{"status":"ok"}',
    })
    Object.defineProperty(window, 'desktopAPI', {
      configurable: true,
      value: { requestBackend },
    })

    const response = await proxyFetch(
      'http://localhost:8000/api/status',
      { headers: { Accept: 'application/json' } },
      vi.fn(),
    )

    expect(await response.json()).toEqual({ status: 'ok' })
    expect(requestBackend).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      body: null,
    }))
  })

  it.each([204, 304])('answers a %i with an empty body instead of throwing', async (status) => {
    const requestBackend = vi.fn().mockResolvedValue({
      ok: status < 300,
      status,
      statusText: '',
      headers: { etag: '"jobs-13"' },
      body: '',
      bytes: new ArrayBuffer(0),
    })
    Object.defineProperty(window, 'desktopAPI', { configurable: true, value: { requestBackend } })

    const response = await proxyFetch('http://localhost:8000/api/jobs', { headers: { 'If-None-Match': '"jobs-13"' } }, vi.fn())

    expect(response.status).toBe(status)
    expect(response.headers.get('etag')).toBe('"jobs-13"')
    expect(await response.text()).toBe('')
    expect(requestBackend).toHaveBeenCalledWith(expect.objectContaining({
      headers: { 'if-none-match': '"jobs-13"' },
    }))
  })

  it('encodes multipart bytes and routes them through Rust with its boundary', async () => {
    const requestBackend = vi.fn().mockResolvedValue({ status: 204, headers: {} })
    Object.defineProperty(window, 'desktopAPI', { configurable: true, value: { requestBackend } })
    const originalFetch = vi.fn()
    const form = new FormData()
    form.set('name', 'export.zip')
    await proxyFetch('http://localhost:8000/api/playlists/spotify-export/parse', { method: 'POST', body: form }, originalFetch)
    expect(originalFetch).not.toHaveBeenCalled()
    const sent = requestBackend.mock.calls[0][0]
    expect(sent.headers['content-type']).toContain('multipart/form-data; boundary=')
    const bytes = new TextDecoder().decode(new Uint8Array(sent.bodyBytes))
    expect(bytes).toContain('export.zip')
    expect(bytes).toContain('name="name"')
  })
})
