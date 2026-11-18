/** Keep native access behind this accessor so browser sessions and tests can substitute the bridge.
 * Missing native support throws: empty stub data would hide a broken shell installation. */
import { BRIDGE_KEY, type KrobiBridge } from './lib/ipc'

let override: KrobiBridge | null = null

/**
 * Point the renderer at a fake bridge. Test-only, and it returns its own
 * undo so a test cannot leak one fake into the next test.
 */
export function setFakeBridgeForTest(fake: KrobiBridge): () => void {
  override = fake
  return () => {
    override = null
  }
}

function missingBridge(): never {
  throw new Error(
    'No hay puente con el proceso principal. ' +
      '(The preload script did not run, or this is a browser context.)',
  )
}

/** The bridge, or a clear failure. Never a silently empty stand-in. */
export function bridge(): KrobiBridge {
  if (override) return override
  const found = (globalThis as Record<string, unknown>)[BRIDGE_KEY] as KrobiBridge | undefined
  return found ?? missingBridge()
}

/** Whether main is reachable at all; for deciding what to render, not for control flow. */
export function hasBridge(): boolean {
  return override !== null || BRIDGE_KEY in (globalThis as Record<string, unknown>)
}
