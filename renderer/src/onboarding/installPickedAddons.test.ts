import { afterEach, describe, expect, it, vi } from 'vitest'
import { setFakeBridgeForTest } from '../bridge'
import type { KrobiBridge, MacEngineStatus } from '../lib/ipc'
import { installPickedAddons } from './installPickedAddons'

let restore: (() => void) | undefined
afterEach(() => { restore?.(); vi.useRealTimers() })

/** The fake shell preserves the single installer and automatic engine provisioning. */
function shell() {
  const installs: string[] = []
  const status = { installed: false, installing: null, installError: null } as MacEngineStatus
  const invoke = vi.fn(async (channel: string, request?: { target?: string; enabled?: boolean }) => {
    if (channel === 'lyrics:engine-status') return { ...status }
    if (channel === 'lyrics:worker-set') {
      status.enabled = !!request?.enabled
      // Enabling an empty helper provisions the full engine unless an install is active.
      if (!status.installed && !status.installing) {
        installs.push('engine')
        status.installing = { target: 'engine', phase: 'paquetes', percent: null }
      }
      return { ok: true }
    }
    if (channel === 'lyrics:engine-install') {
      if (status.installing) return { started: true, already: true }
      const target = request?.target ?? 'engine'
      installs.push(target)
      status.installing = { target, phase: 'paquetes', percent: null }
      return { started: true }
    }
    throw new Error(`Unexpected IPC: ${channel}`)
  })
  restore = setFakeBridgeForTest({ invoke, on: () => () => {} } as KrobiBridge)
  return { status, invoke, installs }
}

describe('picked add-on installation through the real worker switch', () => {
  it('starts only the analysis target before enabling an empty worker', async () => {
    const native = shell()
    await installPickedAddons(['analysis'])
    expect(native.installs).toEqual(['analysis'])
    expect(native.invoke).toHaveBeenCalledWith('lyrics:engine-install', { target: 'analysis' })
    expect(native.invoke).toHaveBeenCalledWith('lyrics:worker-set', { enabled: true })
    expect(native.status.enabled).toBe(true)
  })
  it.each(['lyrics', 'stems'] as const)('keeps %s provisioning and queues analysis after the engine completes', async id => {
    vi.useFakeTimers()
    const native = shell()
    const pending = installPickedAddons([id, 'analysis'])
    await vi.advanceTimersByTimeAsync(0)
    expect(native.installs).toEqual(['engine'])
    expect(native.invoke).not.toHaveBeenCalledWith('lyrics:engine-install', { target: 'analysis' })
    native.status.installed = true
    native.status.installing = null
    await vi.advanceTimersByTimeAsync(1000)
    await pending
    expect(native.installs).toEqual(['engine', 'analysis'])
    expect(native.status.enabled).toBe(true)
    expect(native.invoke.mock.calls.filter(([channel]) => channel === 'lyrics:worker-set')).toEqual([
      ['lyrics:worker-set', { enabled: true }],
    ])
  })
  it('keeps Lyrics and Stems on their existing single shared worker call', async () => {
    const native = shell()
    await installPickedAddons(['lyrics', 'stems'])
    expect(native.installs).toEqual(['engine'])
    expect(native.invoke.mock.calls.filter(([channel]) => channel === 'lyrics:worker-set')).toHaveLength(1)
  })
  it('does not enable an empty worker when the analysis install is rejected', async () => {
    const native = shell()
    native.invoke.mockImplementation(async channel => channel === 'lyrics:engine-status'
      ? { ...native.status }
      : { started: false, reason: 'no-worker-source' })
    await expect(installPickedAddons(['analysis'])).rejects.toThrow('no-worker-source')
    expect(native.invoke).not.toHaveBeenCalledWith('lyrics:worker-set', { enabled: true })
  })
  it('reports a failed preceding install instead of silently losing the queued target', async () => {
    vi.useFakeTimers()
    const native = shell()
    const pending = expect(installPickedAddons(['lyrics', 'analysis'])).rejects.toThrow('download-failed')
    await vi.advanceTimersByTimeAsync(0)
    native.status.installing = null
    native.status.installError = 'download-failed'
    await vi.advanceTimersByTimeAsync(1000)
    await pending
    expect(native.installs).toEqual(['engine'])
  })
})
