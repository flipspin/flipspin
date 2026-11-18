import { useStatus } from "../../state/useStatus";
import { useAddToPlaylistMenu } from "../tracks/useAddToPlaylistMenu";
import { useSongMenu } from "../tracks/useSongMenu";
import TrackContextMenu, { menuPointFrom } from "../../albums/TrackContextMenu";
import { memo, useDeferredValue, useId, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useAudioPlayer } from "@state/AudioPlayerContext";
import { buildAlbumCoverUrl, buildCoverImageUrl } from "@lib/api";
import { usePlaylistSummaries } from "@lib/playlistSummaries";
import { openPlaylist } from "../../shell/routeStore";
import { openLibraryAlbum, openLibraryArtist, replace, reset, searchRoute } from "../../browse/navigationStore";
import { decorate, type ListedAlbum } from "../../home/decorateTrack";
import CoverCard from "../../ui/components/CoverCard";
import CoverTile, { CoverMosaic } from "../../ui/components/CoverTile";
import PanelHeader from "../../ui/components/PanelHeader";
import SectionFoldButton from "../../ui/components/SectionFoldButton";
import { highlightMatches } from "../../ui/components/highlightMatches";
import AlbumTrackRow from "../../albums/AlbumTrackRow";
import SongTableHeader from "../tracks/SongTableHeader";
import { TrackInfoHost } from "../tracks/TrackInfoModal";
import { openTrackInfo } from "../tracks/trackInfoStore";
import { EmptySongColumnsContext, songTableRootClass, useEmptySongColumns, useSongTableColumns } from "../tracks/songTableColumns";
import { sortTracks } from "../../ui/components/useTableSort";
import { playlistCount, playlistCover, playlistCoverAlbums } from "../../playlists/playlistBadge";
import { librarySearchHistory, librarySearchIndex, searchLibrary, type SearchSong } from "./librarySearch";
import SearchScopeSwitch from "./SearchScopeSwitch";
import "./library-search.css";

const FOLDS_KEY = "krobi.librarySearch.collapsedGroups";
function readFolds(): Record<string, boolean> {
  try {
    const value = JSON.parse(localStorage.getItem(FOLDS_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function ResultGroup({ name, title, count, accent, children, actions }: {
  name: string; title: string; count: number; accent: string; children: ReactNode; actions?: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => readFolds()[name] === true);
  const id = useId();
  return <section aria-label={title} className="bg-panel border-2 border-black rounded-xl shadow-[4px_4px_0_var(--ink)] overflow-hidden">
    <PanelHeader accent={accent} title={<SectionFoldButton title={title} count={count} open={!collapsed} controls={id}
      className="library-search-results__fold" onToggle={() => {
        const next = !collapsed; setCollapsed(next);
        try { localStorage.setItem(FOLDS_KEY, JSON.stringify({ ...readFolds(), [name]: next })); } catch { /* storage may be unavailable */ }
      }} />} actions={collapsed ? undefined : actions} />
    <div id={id} hidden={collapsed}>{!collapsed && children}</div>
  </section>;
}

export default function LibrarySearchPage({ albums, query }: { albums: ListedAlbum[]; query: string }) {
  const playlists = usePlaylistSummaries();
  const index = useMemo(() => librarySearchIndex(albums, playlists), [albums, playlists]);
  const deferredQuery = useDeferredValue(query);
  const results = useMemo(() => searchLibrary(index, deferredQuery), [index, deferredQuery]);
  const count = Object.values(results).reduce((sum, rows) => sum + rows.length, 0);
  return <div aria-busy={query !== deferredQuery}><SearchScopeSwitch scope="library" query={query} libraryCount={count} /><LibrarySearchResults query={deferredQuery} results={results} /></div>;
}

// Keep the previous results completely still during the urgent input render.
const LibrarySearchResults = memo(function LibrarySearchResults({ query: deferredQuery, results }: {
  query: string; results: ReturnType<typeof searchLibrary>;
}) {
  const { t } = useTranslation();
  const [allFor, setAllFor] = useState<string | null>(null);
  const [infoOpened, setInfoOpened] = useState(false);
  const [sort, setSort] = useState({ field: null as string | null, dir: "asc" });
  const player = useAudioPlayer();
  const [menu, setMenu] = useState<{ x: number; y: number; song: SearchSong } | null>(null);
  const { showSuccess, showError } = useStatus();
  const playlistMenu = useAddToPlaylistMenu({ showSuccess, showError });
  const songMenu = useSongMenu(menu ? [menu.song] : [], { showSuccess, showError });
  const columns = useSongTableColumns();
  const emptyColumns = useEmptySongColumns(results.songs);
  const ordered = useMemo(() => sort.field ? sortTracks(results.songs, sort.field, sort.dir) as SearchSong[] : results.songs, [results.songs, sort]);
  const songs = allFor === deferredQuery ? ordered : ordered.slice(0, 4);
  const total = results.artists.length + results.songs.length + results.albums.length + results.playlists.length;
  const remember = () => librarySearchHistory.rememberSearch(deferredQuery);
  const openArtist = (name: string) => { remember(); openLibraryArtist(name); };
  const openAlbum = (album: ListedAlbum) => { remember(); openLibraryAlbum(album); };
  const playSong = (song: SearchSong) => {
    remember();
    const queue = ordered.map(track => decorate(track, track.album));
    const at = Math.max(0, queue.findIndex(track => track.path === song.path));
    player.play(queue[at], { replaceQueue: true, upcomingTracks: queue.slice(at + 1), context: queue });
  };
  const menuItems = menu ? songMenu.build({
    onPlay: () => playSong(menu.song),
    onPlayNext: () => player.addNextInQueue([decorate(menu.song, menu.song.album)]),
    onQueue: () => player.addToQueue([decorate(menu.song, menu.song.album)]),
    playlistSubmenu: playlistMenu.submenu([menu.song]),
  }) : [];

  if (!deferredQuery.trim()) return null;
  if (!total) return <div className="flex flex-col items-center gap-4 py-16 text-center" role="status">
    <b>{t("Not in your library")}</b>
    <button type="button" className="explore-button" onClick={() => { remember(); replace(searchRoute(deferredQuery)); }}>
      {t("Search for \"{{query}}\" in Explore", { query: deferredQuery })}
    </button>
  </div>;
  return <div className="library-search-results">
    <span className="font-mono text-xs text-[var(--ink-3)]" role="status">{t("{{n}} results", { n: total })}</span>
    {results.artists.length > 0 && <ResultGroup name="artists" title={t("Artists")} count={results.artists.length} accent="var(--purple)">
      <div className="p-3 flex flex-col gap-2">
        {results.artists.map(artist => <button key={artist.name} type="button" className="library-search-results__artist" onClick={() => openArtist(artist.name)}>
          <span className="w-12 h-12 shrink-0 rounded-full overflow-hidden"><CoverTile src={artist.coverAlbum.cover || buildAlbumCoverUrl(artist.coverAlbum)} label={artist.name} fontSize="16px" className="w-full h-full" /></span>
          <span className="min-w-0"><span className="font-bold">{highlightMatches(artist.name, deferredQuery)}</span>
            <span className="block text-xs text-[var(--ink-3)]">{t("{{n}} albums", { count: artist.albums.size, n: artist.albums.size })} · {t("{{n}} songs", { count: artist.songs, n: artist.songs })}</span></span>
        </button>)}
      </div>
    </ResultGroup>}
    {results.songs.length > 0 && <ResultGroup name="songs" title={t("Songs")} count={results.songs.length} accent="var(--yellow)"
      actions={results.songs.length > 4 && allFor !== deferredQuery ? <button type="button" className="explore-link" onClick={() => setAllFor(deferredQuery)}>{t("View all {{n}}", { n: results.songs.length })}</button> : undefined}>
      <EmptySongColumnsContext.Provider value={emptyColumns}>
      <div className={`retro-song-table retro-song-table--embedded ${songTableRootClass(columns, false, "library", emptyColumns)}`}>
        <SongTableHeader sortField={sort.field} sortDir={sort.dir} onSort={field => setSort(old => ({ field, dir: old.field === field && old.dir === "asc" ? "desc" : "asc" }))} />
        <ul className="retro-song-table__body text-sm list-none m-0 p-0">
          {songs.map((song, i) => <AlbumTrackRow key={song.path} track={song} album={song.album} index={i} number={i + 1}
            searchQuery={deferredQuery} highlightMatches={highlightMatches} showCovers={columns.covers.library}
            isActive={player.selectedTrack?.path === song.path} onSelect={undefined} onPlay={playSong} playOnClick
            language={undefined} selected={false} playList={ordered} playAlbum={null}
            onDownload={undefined} onOpenAnalysis={track => { setInfoOpened(true); openTrackInfo(track); }} onContextMenu={(song: SearchSong, event: React.MouseEvent) => { event.preventDefault(); setMenu({ ...menuPointFrom(event), song }); playlistMenu.refresh(); }}
            onOpenAlbum={(track: SearchSong) => openAlbum(track.album)} onOpenArtist={openArtist} />)}
        </ul>
      </div>
      </EmptySongColumnsContext.Provider>
    </ResultGroup>}
    {results.albums.length > 0 && <ResultGroup name="albums" title={t("Albums")} count={results.albums.length} accent="var(--blue)">
      <ul className="library-search-results__cards">{results.albums.map(album => <li key={album.path}>
        <CoverCard size="100%" cover={<CoverTile src={album.cover || buildAlbumCoverUrl(album)} label={album.album || ""} fontSize="36px" className="w-full h-full" />} title={album.album || t("Album")}
          titleContent={highlightMatches(album.album || t("Album"), deferredQuery)}
          subtitle={<>{highlightMatches(album.artist || "", deferredQuery)}{album.year ? ` · ${album.year}` : ""}</>} onOpen={() => openAlbum(album)} />
      </li>)}</ul>
    </ResultGroup>}
    {results.playlists.length > 0 && <ResultGroup name="playlists" title={t("Playlists")} count={results.playlists.length} accent="var(--teal)">
      <ul className="library-search-results__cards">{results.playlists.map(playlist => {
        const own = playlistCover(playlist);
        const covers = own ? [own] : playlistCoverAlbums(playlist).map(dir => buildCoverImageUrl(dir)).filter(Boolean);
        const count = playlistCount(playlist);
        return <li key={playlist.name}><CoverCard size="100%" title={playlist.name} titleContent={highlightMatches(playlist.name, deferredQuery)}
          cover={<CoverMosaic covers={covers} label={playlist.name} fontSize="36px" className="w-full h-full" />}
          subtitle={count != null ? t("{{n}} songs", { count, n: count }) : undefined}
          onOpen={() => { remember(); reset(); openPlaylist(playlist.name); }} /></li>;
      })}</ul>
    </ResultGroup>}
    <TrackContextMenu open={menu != null} x={menu?.x ?? 0} y={menu?.y ?? 0} items={menuItems} onClose={() => setMenu(null)} />
    {infoOpened && <TrackInfoHost />}
  </div>;
});
