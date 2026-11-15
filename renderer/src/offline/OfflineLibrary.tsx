import { createContext, useContext, type ReactNode } from 'react'
import { useOffline } from './useOffline'

const OfflineLibrary = createContext({ offline: false })
const offlineMode = { offline: true }
const onlineMode = { offline: false }
export function OfflineLibraryProvider({ children }: { albums: { tracks?: { relPath?: string }[] }[]; children: ReactNode }) {
  const offline = useOffline()
  // Row availability comes from its per-key offline snapshot. Only a mode
  // change should invalidate the whole table, never another song's transfer.
  return <OfflineLibrary.Provider value={offline ? offlineMode : onlineMode}>{children}</OfflineLibrary.Provider>
}
// eslint-disable-next-line react-refresh/only-export-components
export function useOfflineLibrary() { return useContext(OfflineLibrary) }
