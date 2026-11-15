import { focusManager } from '@tanstack/react-query'

export type PollPolicy = 'idle' | 'active' | 'restarting' | 'waiting'

/** All server checks stop when the main window loses focus. Local playback is independent. */
export function poll(policy: PollPolicy, running = false, fast = 2_000, idle: number | false = 60_000): number | false {
  if (!focusManager.isFocused() || (typeof document !== 'undefined' && document.hidden)) return false
  if (policy === 'idle') return idle
  if (policy === 'restarting') return running ? 2_000 : idle
  return running ? fast : idle
}

/** Serial polling for stores outside TanStack. No timer survives blur; resume catches up once. */
export function startPoll(interval: () => number | false, check: () => unknown | Promise<unknown>, immediate = true, catchUp = true): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let running = false
  let catchUpPending = false
  const clear = () => { clearTimeout(timer); timer = undefined }
  const schedule = () => {
    clear()
    const ms = interval()
    if (!disposed && !running && ms !== false) timer = setTimeout(() => { void run() }, ms)
  }
  const run = async () => {
    clear()
    if (disposed || running || !focusManager.isFocused() || interval() === false) return
    running = true
    try { await check() } finally {
      running = false
      if (catchUpPending && !disposed && focusManager.isFocused()) { catchUpPending = false; void run() }
      else schedule()
    }
  }
  let previousFocus = focusManager.isFocused()
  const off = focusManager.subscribe(focused => {
    if (focused === previousFocus) return
    previousFocus = focused
    clear()
    if (focused) {
      if (catchUp && running) catchUpPending = true
      else if (catchUp) void run()
      else schedule()
    }
  })
  if (immediate) void run()
  else schedule()
  return () => { disposed = true; clear(); off() }
}

/** Await the next check in an imperative operation; blur suspends the wait until focus returns. */
export function waitForPoll(fast: number): Promise<void> {
  return new Promise(resolve => {
    const stop = startPoll(() => poll('active', true, fast), () => { stop(); resolve() }, false)
  })
}
