/** Desktop surface adapter for screenshots; HTTP and IPC are supplied by Playwright. */
import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/geist-mono/400.css'
import '../src/ui/tokens/app.css'
import '../src/ui/overlay.css'
import '../src/ui/buttons.css'
import '../src/index.css'
import '../src/i18n'
import { useSettingsNavigation } from '../src/settings/useSettingsNavigation'
import { DataProvider } from '../src/data'
import { UiProvider } from '../src/ui'
import { SettingsPage } from '../src/settings/SettingsPage'
import AlbumTrackRow from '../src/albums/AlbumTrackRow'
import SongTableHeader from '../src/library/tracks/SongTableHeader'
import TrackContextMenu, { menuPointFrom } from '../src/albums/TrackContextMenu'
import { songMenuItems } from '../src/library/tracks/songMenuItems'
import { useSongBpmMenu } from '../src/library/tracks/useSongBpmMenu'
import { useSongSelection } from '../src/library/tracks/useSongSelection'
import { TrackInfoHost } from '../src/library/tracks/TrackInfoModal'
import { closeTrackInfo, openTrackInfo } from '../src/library/tracks/trackInfoStore'
import { TrackTagsHost } from '../src/library/tracks/TrackTagsHost'
import TrackTagsModal from '../src/albums/TrackTagsModal'
import { setLibraryRoot } from '../src/lib/libraryKeys'
import type { SchemaAlbumWithMetadata } from '../src/api/generated/schema'

const params = new URLSearchParams(location.search)
const surface = params.get('surface')
const album: SchemaAlbumWithMetadata | null = params.has('album') ? JSON.parse(params.get('album')!) : null
setLibraryRoot('/music')
function MenuSurface({ album }: { album: SchemaAlbumWithMetadata }) {
  const [menu, setMenu] = useState<{ x: number; y: number; songs: typeof album.tracks } | null>(null)
  const selection = useSongSelection(album.tracks)
  const bpmMenu = useSongBpmMenu()
  const items = songMenuItems({ onPlay() {}, onPlayNext() {}, onQueue() {}, bpmItems: bpmMenu(menu?.songs ?? []) })
  return <main style={{ padding: 32 }}>
    <h1>{album.album}</h1>
    <div className="retro-song-table song-table--hide-genre song-table--hide-date song-table--hide-lyrics">
      <SongTableHeader sortField="title" sortDir="asc" onSort={() => {}} columnPicker={false} />
      <ul>{album.tracks.map((track, index) => <AlbumTrackRow key={track.path} track={track} album={album} index={index}
        selected={selection.isSelected(track)} onSelect={selection.click} onPlay={() => {}}
        onContextMenu={(song: typeof track, event: React.MouseEvent) => { event.preventDefault(); setMenu({ ...menuPointFrom(event), songs: selection.forRow(song) }) }} />)}</ul>
    </div>
    <TrackContextMenu open={!!menu} x={menu?.x ?? 0} y={menu?.y ?? 0} items={items} onClose={() => setMenu(null)} />
  </main>
}
function Surface() {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const request = useSettingsNavigation(() => setSettingsOpen(true))
  useEffect(() => {
    if (surface !== 'sheet' || !album) return;
    openTrackInfo({ ...album.tracks[0], album });
    return closeTrackInfo;
  }, []);
  if (settingsOpen) return <SettingsPage key={request?.nonce} initialSection={request?.section} surface="app" host={{ palette: 'paper', setPalette: () => {}, palettes: [], mode, setMode: () => {} }} />
  if (surface === 'tags' && album) return <TrackTagsModal open track={{ ...album.tracks[0], album }} onClose={() => {}} onSave={() => {}} />
  if (surface === 'menu' && album) return <MenuSurface album={album} />
  if (surface === 'sheet' && album) return <><TrackInfoHost /><TrackTagsHost /></>
  if (surface === 'table' && album) return <main style={{ padding: 32 }}><div className="retro-song-table song-table--hide-genre song-table--hide-date song-table--hide-lyrics"><SongTableHeader sortField="title" sortDir="asc" onSort={() => {}} columnPicker={false} /><ul>{album.tracks.map((track, index) => <AlbumTrackRow key={track.path} track={track} album={album} index={index} onPlay={() => {}} />)}</ul></div></main>
  return <SettingsPage initialSection={params.get('section') || 'complementos'} surface="app" host={{ palette: 'paper', setPalette: () => {}, palettes: [], mode, setMode: () => {} }} />
}


const mode = localStorage.getItem('krobi.mode') || 'light'
document.documentElement.dataset.theme = 'paper'
document.documentElement.dataset.mode = mode
createRoot(document.getElementById('root')!).render(<UiProvider><DataProvider><Surface /></DataProvider></UiProvider>)
