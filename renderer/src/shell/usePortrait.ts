import { useSyncExternalStore } from 'react'

/** Use orientation rather than width: a wide portrait window still needs the compact shell.
 * JavaScript selects the shell structure, while CSS handles its layout. */
const QUERY = '(orientation: portrait)'

function query(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia(QUERY)
}

function subscribe(onChange: () => void): () => void {
  const mq = query()
  if (!mq) return () => {}
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}

function snapshot(): boolean {
  return query()?.matches ?? false
}

export function usePortrait(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}
