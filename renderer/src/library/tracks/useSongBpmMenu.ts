import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { relPathOf } from '@state/userLibraryStore'
import { announceLibraryChanged } from '@lib/libraryEvents'
import { apiGet, apiPut, isApiError, useCurrentUser } from '../../data'
import { analysisKeys } from '../../analysis/data'
import { scaledBpm, type BpmFactor } from '../../analysis/bpm'
import { notify } from '../../ui/notifications'
import type { MenuItem } from '../../albums/TrackContextMenu'

export type BpmSong = { path?: string | null; relPath?: string | null; bpm?: unknown; rev?: unknown; bpmSource?: unknown; bpmFixed?: unknown }
type Saved = { relPath: string; rev: number; previous: number | null }

/** Bound the whole read/save/reload sequence, rather than just the PUTs. */
async function eachSong<T>(songs: T[], work: (song: T) => Promise<void>) {
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, songs.length) }, async () => {
    while (cursor < songs.length) await work(songs[cursor++])
  }))
}

/** Shared by every song menu; Undo survives closing or navigating away from it. */
export function useSongBpmMenu() {
  const { t } = useTranslation()
  const me = useCurrentUser()
  const client = useQueryClient()
  const pending = useRef(false)
  const [busy, setBusy] = useState(false)
  const refresh = () => {
    for (const queryKey of [['library'], analysisKeys.summary, analysisKeys.estimates]) void client.invalidateQueries({ queryKey })
    announceLibraryChanged()
  }
  const reload = async (relPath: string) => {
    const view = await apiGet('/api/analysis/{relPath}', { params: { path: { relPath } } })
    client.setQueryData(analysisKeys.track(relPath), view)
    return view
  }
  const write = async (relPath: string, rev: number, bpm: number | null) => {
    await client.cancelQueries({ queryKey: analysisKeys.track(relPath) })
    try {
      const view = await apiPut('/api/analysis/{relPath}/fixed', { params: { path: { relPath } }, body: { rev, bpm } })
      client.setQueryData(analysisKeys.track(relPath), view)
      return view
    } catch (error) {
      if (isApiError(error) && error.status === 409) { await reload(relPath); return null }
      throw error
    }
  }
  const undo = async (saved: Saved[]) => {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    let restored = 0
    try {
      await eachSong(saved, async song => {
        try { if (await write(song.relPath, song.rev, song.previous)) restored++ }
        catch { /* Included in the single result notification below. */ }
      })
      notify({ id: 'analysis-confirmation', message: t("BPM restored for {{count}} songs", { count: restored }) + (restored < saved.length ? ` · ${t("{{count}} skipped", { count: saved.length - restored })}` : '') })
    } finally { refresh(); pending.current = false; setBusy(false) }
  }
  const scale = async (songs: BpmSong[], factor: BpmFactor) => {
    if (pending.current || !me.data?.isOwner) return
    pending.current = true
    setBusy(true)
    const saved: Saved[] = []
    try {
      await eachSong(songs, async song => {
        const bpm = scaledBpm(song.bpm, factor)
        const relPath = relPathOf(song)
        if (bpm === null || !relPath) return
        try {
          // Listings with a revision and a known source already carry the snapshot.
          const sourceKnown = song.bpmSource === 'fixed' || song.bpmSource === 'tag' || song.bpmSource === 'computed' || typeof song.bpmFixed === 'boolean'
          const snapshot = typeof song.rev === 'number' && sourceKnown
            ? { rev: song.rev, bpm: song.bpm, previous: song.bpmSource === 'fixed' || song.bpmFixed === true ? song.bpm as number : null }
            : await reload(relPath).then(view => ({ rev: view.rev, bpm: view.bpm.value, previous: view.fixed.bpm }))
          // A missing listing revision must not let a stale preview overwrite a newer BPM.
          if (snapshot.bpm !== song.bpm) return
          const view = await write(relPath, snapshot.rev, bpm)
          if (view) saved.push({ relPath, rev: view.rev, previous: snapshot.previous })
        } catch { /* A failed read/save is skipped; other songs keep going. */ }
      })
      const skipped = songs.length - saved.length
      notify({ id: 'analysis-confirmation', level: saved.length ? 'success' : 'info', sticky: saved.length > 0,
        message: (skipped
          ? t(factor === 2 ? "Doubled {{count}}" : "Halved {{count}}", { count: saved.length }) + ` · ${t("{{count}} skipped", { count: skipped })}`
          : t(factor === 2 ? "BPM doubled for {{count}} songs" : "BPM halved for {{count}} songs", { count: saved.length })),
        action: saved.length ? { label: t("Undo"), onSelect: () => { void undo(saved) } } : undefined,
      })
    } finally { refresh(); pending.current = false; setBusy(false) }
  }
  return (selection: BpmSong[]): MenuItem[] => {
    if (!me.data?.isOwner) return []
    const songs = [...new Map(selection.map(song => [relPathOf(song) || song.path, song])).values()]
    if (!songs.some(song => typeof song.bpm === 'number' && Number.isFinite(song.bpm) && song.bpm > 0)) return []
    return ([2, 0.5] as const).map(factor => {
      const eligible = songs.filter(song => relPathOf(song) && scaledBpm(song.bpm, factor) !== null)
      const result = songs.length === 1 ? scaledBpm(songs[0].bpm, factor) : null
      const label = t(factor === 2 ? "Double BPM" : "Halve BPM")
      return { label: `${label} · ${result !== null ? `${songs[0].bpm} → ${result}` : t("{{count}} songs", { count: eligible.length })}`,
        disabled: busy || eligible.length === 0, onClick: () => { void scale(songs, factor) } }
    })
  }
}
