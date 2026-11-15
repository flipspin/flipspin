import { focusManager, type QueryClient } from '@tanstack/react-query'
import contract from '../../../contracts/change-areas.json'
import type { ChangeRevision, KrobiBridge, ServerChange, ServerHello, ServerStream } from '../lib/ipc'
import { apiUrl, withApiToken } from '../lib/api'
import { subscribeToken } from '../lib/authToken'
import { deliverChanges } from './changeListeners'
import { setStreamState, streamStore } from './streamState'

export const changeAreas: Record<string, { query_key_prefixes: string[][] }> = contract.areas
const allAreas = Object.keys(changeAreas)
function mappedArea(area: string) { return area.startsWith('me:') ? 'me:<account>' : area }

/** One handler per renderer cache. Only mounted, enabled queries are refetched. */
export function changeHandler(client: QueryClient) {
  let bootId: string | undefined
  let revisions: Record<string, ChangeRevision> = {}
  const dirty = new Set<string>()
  let all = false
  let generation = 0
  let disposed = false
  const flush = () => {
    if (!focusManager.isFocused() || !dirty.size) return
    const areas = new Set(dirty)
    const version = generation
    const invalidateAll = all
    all = false
    const prefixes = [...dirty].flatMap(area => changeAreas[area]?.query_key_prefixes ?? [])
    dirty.clear()
    // One pass avoids duplicate fetches where areas share a prefix.
    const filter = { type: 'active' as const, predicate: (query: { queryKey: readonly unknown[] }) => invalidateAll || prefixes.some(prefix => prefix.every((part, index) => query.queryKey[index] === part)) }
    // Cancel even an initial read with no cached data: ordinary invalidation
    // joins that flight, which may contain a snapshot older than this event.
    void client.cancelQueries(filter).then(() => {
      if (disposed || version !== generation) return
      if (!focusManager.isFocused()) {
        areas.forEach(area => dirty.add(area))
        all ||= invalidateAll
        return
      }
      return client.invalidateQueries(filter)
    })
  }
  const mark = (areas: Iterable<string>) => {
    const affected = new Set([...areas].map(mappedArea).filter(area => area in changeAreas))
    affected.forEach(area => dirty.add(area))
    // Imperative stores keep one pending read across a quiet period.
    deliverChanges(affected)
    flush()
  }
  const focus = focusManager.subscribe(focused => { if (focused) flush() })
  return {
    changed(event: ServerChange) {
      if (revisions[event.area] === event.rev) return
      revisions[event.area] = event.rev
      mark([event.area])
    },
    hello(event: ServerHello) {
      // The first hello also repairs the initial snapshot/subscribe race.
      if (bootId !== event.bootId) all = true
      const areas = bootId !== event.bootId ? allAreas : [...new Set([...Object.keys(revisions), ...Object.keys(event.revisions)])]
        .filter(area => revisions[area] !== event.revisions[area])
      bootId = event.bootId
      revisions = { ...event.revisions }
      mark(areas)
    },
    reset() { generation++; bootId = undefined; revisions = {}; dirty.clear(); all = false },
    dispose() { disposed = true; focus() },
  }
}

/** Register listeners before reading the shell snapshot; fence any newer push. */
export function startChanges(client: QueryClient, bridge: KrobiBridge | null | undefined): () => void {
  const handler = changeHandler(client)
  let live = true
  let version = 0
  const reset = () => { version++; handler.reset() }
  const stream = (value: ServerStream) => {
    // The next hello refetches displayed data even if revisions still match.
    if (value.state === 'lost' && streamStore.getSnapshot().state !== 'lost') handler.reset()
    setStreamState(value)
  }
  const offToken = subscribeToken(reset)
  if (bridge) {
    const stops = [
      bridge.on('server:changed', value => { version++; handler.changed(value) }),
      bridge.on('server:hello', value => { version++; handler.hello(value) }),
      bridge.on('server:stream', value => { version++; stream(value) }),
      bridge.on('auth:changed', reset),
    ]
    const readSnapshot = () => {
      const before = version
      void bridge.invoke('server:stream-snapshot', undefined).then(value => {
        if (!live || !value) return
        // A nudge can arrive while IPC reads the snapshot. Read again rather
        // than losing the initial hello or overwriting a newer revision.
        if (version !== before) { readSnapshot(); return }
        stream(value.stream)
        if (value.hello) handler.hello(value.hello)
      }).catch(() => {})
    }
    readSnapshot()
    return () => { live = false; stops.forEach(stop => stop()); offToken(); handler.dispose() }
  }
  let source: EventSource | undefined
  const open = () => {
    source?.close()
    if (typeof EventSource === 'undefined') return
    stream({ state: 'connecting', since: Date.now() })
    source = new EventSource(withApiToken(apiUrl('/api/events')!))
    source.addEventListener('hello', event => {
      try {
        handler.hello(JSON.parse((event as MessageEvent<string>).data) as ServerHello)
        stream({ state: 'connected', since: Date.now() })
      } catch { /* A malformed nudge cannot alter the cache. */ }
    })
    source.addEventListener('change', event => {
      try { handler.changed(JSON.parse((event as MessageEvent<string>).data) as ServerChange) } catch { /* Ignore malformed nudges. */ }
    })
    source.onerror = () => {
      // EventSource retries can fail repeatedly during the same outage.
      if (streamStore.getSnapshot().state !== 'lost') stream({ state: 'lost', since: Date.now() })
    }
  }
  const auth = subscribeToken(() => { handler.reset(); open() })
  open()
  return () => { live = false; source?.close(); auth(); offToken(); handler.dispose() }
}
