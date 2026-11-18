import { useEffect, useState } from 'react'
import { apiGet } from '../data/http'
import type { ReplayGain } from './volumeLevelling'

/** Playlist rows and old saved queues may predate the catalog's gain metadata. */
export function useReplayGain(album: string | undefined, file: string | undefined, embedded: ReplayGain | null | undefined, enabled: boolean): { gain: ReplayGain | null | undefined; pending: boolean } {
  const key = album && file ? `${album}/${file}` : null
  const [resolved, setResolved] = useState<{ key: string; gain: ReplayGain | null } | null>(null)
  const needed = enabled && !!key && embedded == null
  useEffect(() => {
    if (!needed || !album || !file || !key) return
    const controller = new AbortController()
    let alive = true
    const finish = (gain: ReplayGain | null) => { if (alive) setResolved({ key, gain }) }
    const timeout = setTimeout(() => { controller.abort(); finish(null) }, 3000)
    void apiGet('/api/analysis/{album}/{file}/replaygain', { params: { path: { album, file } }, signal: controller.signal })
      .then(finish, () => finish(null)).finally(() => clearTimeout(timeout))
    return () => { alive = false; controller.abort(); clearTimeout(timeout) }
  }, [needed, album, file, key])
  return { gain: embedded ?? (resolved?.key === key ? resolved.gain : null), pending: needed && resolved?.key !== key }
}
