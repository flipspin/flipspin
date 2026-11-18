import { act, cleanup, configure, getConfig } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, vi } from 'vitest'

/** Opt in per suite: unmount while the clock is still fake, then discard timers. */
export function installTestClock() {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
  })
}

let restoreAsyncWrapper: (() => void) | undefined

afterEach(() => {
  restoreAsyncWrapper?.()
  restoreAsyncWrapper = undefined
})

async function inAct<T>(callback: () => Promise<T>): Promise<T> {
  let result!: T
  await act(async () => { result = await callback() })
  return result
}

export function clockUser() {
  // RTL's default async wrapper drains through a zero-delay timer and only
  // advances Jest clocks. Wrap user-event in act directly under Vitest instead.
  if (!restoreAsyncWrapper) {
    const { asyncWrapper } = getConfig()
    restoreAsyncWrapper = () => configure({ asyncWrapper })
    configure({ asyncWrapper: inAct })
  }
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTimeAsync })
}

/** Retry a synchronous assertion on virtual time, flushing React between attempts.
 * Dynamic imports use Vite's real I/O; let those settle before consuming the
 * virtual deadline. No wall-clock deadline or arbitrary number of microtasks.
 */
export async function waitForClock<T>(assertion: () => T, { timeout = 1000 } = {}): Promise<T> {
  if (!vi.isFakeTimers()) throw new Error('waitForClock requires fake timers')
  // Flush request continuations before running an expensive accessible DOM query.
  await act(async () => {
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(0)
  })
  for (let elapsed = 0; ; elapsed += 10) {
    try {
      return assertion()
    } catch (error) {
      if (elapsed >= timeout) throw error
    }
    await act(async () => {
      await vi.dynamicImportSettled()
      await vi.advanceTimersByTimeAsync(10)
    })
  }
}

/** Wait for mocked request/React conditions across event-loop turns. Browser
 * layout suites keep native timers for Playwright. Their fixtures resolve
 * immediately; timed application behavior belongs on waitForClock instead.
 */
export async function waitForUi<T>(assertion: () => T): Promise<T> {
  for (let turn = 0; ; turn++) {
    try { return assertion() } catch (error) {
      if (turn === 100) throw error
    }
    await act(() => vi.dynamicImportSettled())
  }
}
