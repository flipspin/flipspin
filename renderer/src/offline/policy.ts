import { connectionStore } from '../connection/connection'
import { getForcedOffline } from './mode'

export function isOfflineNow() {
  const status = connectionStore.getSnapshot()
  if (status.kind === 'ready' && status.value?.connection.state === 'wrong-nest') return false
  return getForcedOffline() || (status.kind === 'ready' && status.value?.connection.state === 'unreachable')
}
