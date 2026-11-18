import { focusManager } from '@tanstack/react-query'

interface Listener { areas: readonly string[]; refresh: () => unknown; dirty: boolean; running: boolean }
// Imperative stores share the transport and foreground boundary with queries.
const listeners = new Set<Listener>()
async function run(entry: Listener) {
  if (!listeners.has(entry) || !focusManager.isFocused()) return
  if (entry.running) { entry.dirty = true; return }
  entry.running = true
  entry.dirty = false
  try { await entry.refresh() } catch { /* Stores own their read errors. */ }
  finally {
    entry.running = false
    // A write received during a snapshot read deserves one follow-up read.
    if (entry.dirty && listeners.has(entry) && focusManager.isFocused()) void run(entry)
  }
}
export function deliverChanges(areas: ReadonlySet<string>) {
  for (const entry of listeners) {
    if (entry.areas.some(area => areas.has(area))) {
      entry.dirty = true
      void run(entry)
    }
  }
}
focusManager.subscribe(focused => {
  if (focused) for (const entry of listeners) if (entry.dirty) void run(entry)
})
export function watchChanges(areas: readonly string[], refresh: () => unknown, immediate = true): () => void {
  const entry: Listener = { areas, refresh, dirty: immediate && !focusManager.isFocused(), running: false }
  listeners.add(entry)
  if (immediate) void run(entry)
  return () => { listeners.delete(entry) }
}
