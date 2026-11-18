/**
 * The address a phone is sent to. A nest this computer hosts answers this app on
 * loopback, so the LAN address has to win whenever the shell knows one.
 */
import { describe, expect, it } from 'vitest'

import { routableAddress } from './useInstall'
import { serverStatus } from './test-support'

describe('routableAddress', () => {
  it('prefers the LAN address of a nest this computer hosts', () => {
    expect(routableAddress(serverStatus({ baseUrl: 'http://127.0.0.1:8000', lanUrl: 'http://192.168.1.20:8000' }))).toBe(
      'http://192.168.1.20:8000',
    )
  })

  it('uses the configured address when there is no LAN address', () => {
    expect(routableAddress(serverStatus({ mode: 'external', baseUrl: 'http://192.0.2.10:8000', lanUrl: null }))).toBe(
      'http://192.0.2.10:8000',
    )
  })

  it('is empty with no status at all', () => {
    expect(routableAddress(null)).toBe('')
  })
})
