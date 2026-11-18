import { useServerStatus } from '../settings/useInstall'
import { EmptyMusicLibrary } from './MusicStep'

export function LibraryEmptyState() {
  const server = useServerStatus()
  if (server.state.kind === 'loading') return null
  return <EmptyMusicLibrary localNest={server.state.kind === 'ready' && server.state.value?.mode === 'child'} />
}
