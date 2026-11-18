export const POSITION_KEY = 'krobi.player.position'
export interface SavedPosition { origin: string; key: string; seconds: number; savedAt: number }

export function readPosition(origin: string, key: string, storage: Storage): SavedPosition | null {
  try {
    const value: SavedPosition = JSON.parse(storage.getItem(POSITION_KEY) || 'null')
    return value?.origin === origin && value.key === key && Number.isFinite(value.seconds) && Number.isFinite(value.savedAt) ? value : null
  } catch { return null }
}

export function restoreSeconds(value: SavedPosition | null, duration: number): number | null {
  return value && value.seconds > 5 && value.seconds < duration - 10 ? value.seconds : null
}

/** Uses the engine clock, including stems; no React render on each sample. */
export function persistPosition(element: EventTarget, origin: string, key: string, playing: () => boolean, position: () => number, storage: Storage = localStorage) {
  const save = () => {
    const seconds = position()
    if (!Number.isFinite(seconds) || seconds < 0) return
    try { storage.setItem(POSITION_KEY, JSON.stringify({ origin, key, seconds, savedAt: Date.now() })) } catch { /* Device storage is best effort. */ }
  }
  const timer = setInterval(() => { if (playing()) save() }, 5000)
  element.addEventListener('pause', save)
  element.addEventListener('seeked', save)
  window.addEventListener('pagehide', save)
  return () => {
    clearInterval(timer)
    element.removeEventListener('pause', save)
    element.removeEventListener('seeked', save)
    window.removeEventListener('pagehide', save)
  }
}

export function clearPosition(storage: Storage = localStorage) {
  try { storage.removeItem(POSITION_KEY) } catch { /* Device storage is best effort. */ }
}
