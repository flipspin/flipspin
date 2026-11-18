import { useEffect, useState } from 'react'
import { bridge, hasBridge } from '../bridge'
import { useConnection } from '../connection/connection'
import { useForcedOffline } from './mode'
import type { OutboxIntent } from '../lib/ipc'

export function useOffline() {
  const connection = useConnection()
  const forced = useForcedOffline()
  return connection.state !== 'wrong-nest' && (forced || connection.state === 'unreachable')
}
/** A connecting shell may read its saved copy without declaring a network outage. */
export function useSnapshotReads() {
  const connection = useConnection()
  const offline = useOffline()
  return offline || connection.state === 'connecting'
}
export function useOutbox() {
  const [rows, setRows] = useState<OutboxIntent[]>([])
  useEffect(() => {
    if (!hasBridge()) return
    let alive = true, revision = 0
    const refresh = () => {
      const version = ++revision
      void bridge().invoke('offline:outbox', { action: 'list' }).then(value => {
        if (alive && version === revision) setRows(value ?? [])
      }).catch(() => { if (alive) setRows([]) })
    }
    const stop = bridge().on('offline:changed', refresh)
    const auth = bridge().on('auth:changed', () => { setRows([]); refresh() })
    const nest = bridge().on('server:status-changed', status => { if (status?.connection.state === 'wrong-nest') { revision++; setRows([]) } else refresh() })
    refresh()
    return () => { alive = false; stop(); auth(); nest() }
  }, [])
  return rows
}
export function useLocalCopies(keys: string[]) {
  const [copies, setCopies] = useState<Set<string>>(new Set())
  const signature = JSON.stringify(keys)
  useEffect(() => {
    if (!hasBridge()) return
    let alive = true
    const refresh = () => { void bridge().invoke('offline:status', { keys: JSON.parse(signature) as string[] }).then(status => {
      if (alive && status) setCopies(new Set(status.tracks.filter(row => row.verifiedAt !== null && ['descargado', 'desactualizado', 'ya no está en el nido'].includes(row.state)).map(row => row.key)))
    }).catch(() => { if (alive) setCopies(new Set()) }) }
    const stop = bridge().on('offline:changed', refresh)
    const auth = bridge().on('auth:changed', () => { setCopies(new Set()); refresh() })
    refresh()
    return () => { alive = false; stop(); auth() }
  }, [signature])
  return copies
}
