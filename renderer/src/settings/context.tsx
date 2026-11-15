/** Use /api/me isOwner for administration, including synthetic local owners.
 * Hide admin sections for members, anonymous sessions and unanswered identity requests. */
import { createContext, useContext } from 'react'
import type { ComponentType } from 'react'

import type { CurrentUser } from '../data'
import type { ServerStatus } from '../lib/ipc'
import type { InstallState } from './useInstall'
import type { SectionId } from './sections'

export interface PaletteOption {
  id: string
  label: string
  /** [ground, accent, second accent]; the palette's own swatch. */
  swatch: readonly string[]
}

/**
 * The app-side settings Settings edits but does not own: they live in the
 * desktop's contexts (`SettingsContext`, `LibraryContext`), and the shell hands
 * them in so this page stays a typed module with no legacy imports.
 */
export interface SettingsHost {
  openHealthMatch?: (scope: { albumKey: string }) => void
  openHealthBulkTags?: (relPaths: string[]) => void
  playEstimate?: (relPath: string) => void
  openEstimateInfo?: (relPath: string) => void
  openEstimateTags?: (relPath: string) => void
  vlcIp: string
  setVlcIp: (ip: string) => void
  palette: string
  setPalette: (id: string) => void
  palettes: readonly PaletteOption[]
  mode: string
  setMode: (mode: string) => void
  /** The system folder picker; only meaningful on a nest this computer runs. */
  chooseMusicFolder?: () => void
  /** Open another page of the app (an extension's own screen). */
  openPage?: (id: string) => void
  /** The Spotify data-export wizard, from the legacy tree. */
  SpotifyImport?: ComponentType
  /** Spotify's account connection, without credential fields. */
  SpotifyKeys?: ComponentType
}

export type Surface = 'app' | 'dev'

export interface SettingsContextValue {
  surface: Surface
  /** null while `/api/me` is still being asked. */
  admin: boolean | null
  me: CurrentUser | null
  /** What `/api/me` answered with when it failed (401, 409…), else null. */
  meStatus: number | null
  mePending: boolean
  meError: unknown
  refreshMe: () => void
  server: InstallState<ServerStatus | null>
  refreshServer: () => void
  host: SettingsHost
  go: (id: SectionId) => void
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

export const SettingsProvider = SettingsContext.Provider

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext)
  if (value === null) throw new Error('useSettings must be used inside the Settings page')
  return value
}

/** Native controls are available in the desktop shell; Vite dev has no shell. */
export function detectSurface(): Surface {
  return '__TAURI_INTERNALS__' in globalThis ? 'app' : 'dev'
}
