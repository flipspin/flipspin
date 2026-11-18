/**
 * The logger's contract is "never make things worse". These tests are mostly
 * about what happens when the thing it depends on is missing or broken, because
 * that is when it is being called.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { isLogBridgeAvailable, logger } from './logger'

const host = globalThis as Record<string, unknown>

function installBridge(invoke: (channel: string, request: unknown) => unknown): void {
  host['krobi'] = { invoke, on: () => () => undefined }
}

afterEach(() => {
  delete host['krobi']
  vi.restoreAllMocks()
})

describe('logger', () => {
  it('falls back to the console when there is no bridge', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => undefined)

    expect(isLogBridgeAvailable()).toBe(false)
    logger.info('la biblioteca terminó de cargar')

    expect(spy).toHaveBeenCalledWith('[krobi] la biblioteca terminó de cargar')
  })

  it('forwards to main when the bridge is there', () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    installBridge(invoke)

    logger.warn('el servidor no responde', { intentos: 2 })

    expect(isLogBridgeAvailable()).toBe(true)
    expect(invoke).toHaveBeenCalledWith('log:write', {
      level: 'warn',
      message: 'el servidor no responde',
      context: { intentos: 2 },
    })
  })

  it('flattens an Error in the context, which cannot be structured-cloned', () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    installBridge(invoke)

    logger.error('falló la descarga', { causa: new Error('conexión perdida') })

    const [, payload] = invoke.mock.calls[0] as [string, { context: { causa: { message: string } } }]
    expect(payload.context.causa.message).toBe('conexión perdida')
  })

  it('does not throw on a circular context', () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    installBridge(invoke)

    const cyclic: Record<string, unknown> = { nombre: 'álbum' }
    cyclic['self'] = cyclic

    expect(() => logger.debug('estado', cyclic)).not.toThrow()
    expect(invoke).toHaveBeenCalled()
  })

  it('survives a bridge that throws, and still reports somewhere', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    installBridge(() => {
      throw new Error('el canal no existe')
    })

    expect(() => logger.error('algo pasó')).not.toThrow()
    expect(spy).toHaveBeenCalledWith('[krobi] algo pasó')
  })

  it('catches a rejected send instead of leaving an unhandled rejection', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    installBridge(() => Promise.reject(new Error('main se cerró')))

    logger.error('algo pasó')
    await Promise.resolve()
    await Promise.resolve()

    expect(spy).toHaveBeenCalledWith('[krobi] algo pasó')
  })
})
