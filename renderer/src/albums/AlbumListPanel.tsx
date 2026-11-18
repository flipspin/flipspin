import { useSongMenu } from "../library/tracks/useSongMenu";
import React, { useRef, useState, useMemo, useLayoutEffect } from "react";
import { useTranslation } from "react-i18next";
import { load as reloadUserLibrary } from "@state/userLibraryStore";
import type { AudioPlayerValue, PlayerTrack } from "@state/AudioPlayerContext";
import AlbumGrid from "./AlbumGrid";
import AlbumTrackRow from "./AlbumTrackRow";
import SongRows, { type SongRowsHandle } from "./SongRows";
import type { LibraryView } from "./LibraryToolbar";
import LibraryFiltersToolbar from "./LibraryFiltersToolbar";
import { LibraryFiltersActive } from "./LibraryFilters";
import { useLibraryScrollStack } from "./LibraryFiltersStack";
import SelectionBar from "../ui/components/SelectionBar";
import SongTableHeader from "../library/tracks/SongTableHeader";
import { openLibraryAlbum, openLibraryArtist } from "../browse/navigationStore";
import { primaryArtist } from "./artistMatch";
import { useSongSelection } from "../library/tracks/useSongSelection";
import TrackContextMenu, { menuPointFrom, type MenuItem } from "./TrackContextMenu";
import LyricsModal from "../lyrics/LyricsModal";
import { lyricsKeyOf } from "../lyrics/lyricsStore";
import { useAddToPlaylistMenu } from "../library/tracks/useAddToPlaylistMenu";
import { EmptySongColumnsContext, songTableRootClass, useEmptySongColumns, useSongTableColumns } from "../library/tracks/songTableColumns";
import type { DecoratedTrack, ListedAlbum, ListedTrack } from "../home/decorateTrack";
import { albumIdByPath, albumTracksInOrder } from "./libraryPanel";
import { useLibraryScope } from "./hooks/useLibraryScope";
import { savedScrollTop, usePersistedScroll } from "./hooks/usePersistedScroll";

type Song = ListedTrack & { album?: ListedAlbum | null };
type Album = ListedAlbum & { tracks: Song[] };
type Notify = (message: string) => void;

type Props = {
  view: LibraryView;
  isPlaying: boolean;
  setIsPlaying: (playing: boolean) => void;
  selectedTrack: PlayerTrack | null;
  play: AudioPlayerValue["play"];
  decorateTrack: (track: ListedTrack, album?: ListedAlbum | string | null) => DecoratedTrack;
  highlightMatches: (text: string, query: string) => React.ReactNode;
  addToQueue: AudioPlayerValue["addToQueue"];
  addNextInQueue: AudioPlayerValue["addNextInQueue"];
  onOpenAnalysis: (track: Song) => void;
  showSuccess?: Notify;
  showError?: Notify;
  onLibraryChanged?: () => unknown;
};

type TrackMenu = { open: boolean; x: number; y: number; track: Song | null; songs?: Song[] };
type AlbumMenu = { open: boolean; x: number; y: number; album: Album | null };

/** Until the first row is measured (a one-line row at the default type size). */
const ROW_HEIGHT_GUESS = 35;

const NO_ROWS: Song[] = [];

export default function AlbumListPanel({
  view,
  isPlaying,
  setIsPlaying,
  selectedTrack,
  play,
  decorateTrack,
  highlightMatches,
  addToQueue,
  addNextInQueue,
  onOpenAnalysis,
  showSuccess,
  showError,
  onLibraryChanged,
}: Props) {
  const { t, i18n } = useTranslation();
  const playlistMenu = useAddToPlaylistMenu({ showSuccess, showError });
  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const onScroll = usePersistedScroll(scrollRef);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const rowsStartRef = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState(ROW_HEIGHT_GUESS);
  const rowHeightRef = useRef(ROW_HEIGHT_GUESS);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      // The virtual list's row height: one row's real height (it changes when
      // Covers or the narrowest step adds the artist's second line).
      // The cover's intrinsic image dimensions never determine this height.
      const row = el.querySelector<HTMLElement>(".retro-song-table__row");
      const height = row?.offsetHeight;
      if (height && height !== rowHeightRef.current) {
        rowHeightRef.current = height;
        setRowHeight(height);
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (rowsStartRef.current) observer.observe(rowsStartRef.current);
    return () => observer.disconnect();
  });
  const [ctx, setCtx] = useState<TrackMenu>({ open: false, x: 0, y: 0, track: null });
  const [lyricsTrack, setLyricsTrack] = useState<Song | null>(null);

  // The view (filters · sort · layout) lives in useLibraryView; this panel
  // draws it. Both layouts read the same filtered, sorted songs.
  const { filters, sort, layout } = view;
  const searchQuery = view.deferredSearch;
  const { scrollMargin, stackHeight } = useLibraryScrollStack({
    scrollRef, toolbarRef, stackRef, sentinelRef, rowsStartRef,
    filterKey: JSON.stringify({ ...filters, search: searchQuery }), layout,
  });

  // "Nest" or the signed-in account's own rows; see useLibraryScope.
  const scope = useLibraryScope<Song, Album>(view.tracks, view.sortedAlbums);
  const sortedFlat = scope.tracks;
  const scopedAlbums = scope.albums;

  const decorateAll = (songs: Song[]) => songs.map((tr) => decorateTrack(tr, tr.album));

  const handlePlayTrack = (_track: unknown, decoratedList: DecoratedTrack[], startIndex: number) => {
    const idx = startIndex >= 0 ? startIndex : 0;
    play(decoratedList[idx], { replaceQueue: true, upcomingTracks: decoratedList.slice(idx + 1), context: decoratedList });
  };

  // Selection: plain click / ⌘ / Shift / ⌘A / Esc / arrows; shared/useSongSelection.
  // Only the list has rows; the grid selects nothing.
  const selection = useSongSelection(layout === "list" ? sortedFlat : NO_ROWS);

  const rowsRef = useRef<SongRowsHandle>(null);

  //  right-click context menu
  const openCtx = (track: Song, e: React.MouseEvent) => {
    e.preventDefault();
    // Keep a right-clicked multi-selection intact; otherwise actions target only the clicked row.
    const songs = selection.forRow(track);
    // Capture selection before menu mousedown clears it.
    setCtx({ open: true, ...menuPointFrom(e), track, songs });
    playlistMenu.refresh();
  };
  const closeCtx = () => setCtx((c) => ({ ...c, open: false }));

  // Reload from the server so changes from other devices appear without leaving the page.
  const [reloading, setReloading] = useState(false);
  const reload = async () => {
    if (reloading) return;
    setReloading(true);
    try {
      await Promise.all([onLibraryChanged?.(), reloadUserLibrary()]);
    } finally {
      setReloading(false);
    }
  };

  const playSongs = (songs: Song[]) => {
    const decorated = decorateAll(songs);
    if (decorated.length) handlePlayTrack(decorated[0], decorated, 0);
  };

  const playFromFlat = (track: Song) => {
    const decorated = decorateAll(sortedFlat);
    const idx = decorated.findIndex((t) => t.path === track.path);
    handlePlayTrack(decorated[idx >= 0 ? idx : 0], decorated, idx >= 0 ? idx : 0);
  };

  // Opening an album opens its page (a route; the header's back arrow
  // returns here). The "Album" filter stays for narrowing the list.
  const openAlbum = (album: unknown) => openLibraryAlbum(album);

  const ctxTrack = ctx.track;
  const ctxSongs = ctx.songs || [];
  const songMenu = useSongMenu(ctxSongs, { showSuccess, showError, onChanged: () => { selection.clear(); onLibraryChanged?.(); } });
  const { isDownloaded, downloadToThisDevice } = songMenu;
  const ctxItems = ctxTrack ? songMenu.build({
    onPlay: () => ctxSongs.length > 1 ? playSongs(ctxSongs) : playFromFlat(ctxTrack),
    onPlayNext: () => addNextInQueue(decorateAll(ctxSongs)),
    onQueue: () => addToQueue(decorateAll(ctxSongs)),
    playlistSubmenu: playlistMenu.submenu(ctxSongs),
    onOpenLyrics: ctxSongs.length === 1 ? () => setLyricsTrack(ctxTrack) : undefined,
  }) : [];

  //  the grid's albums
  const playAlbum = (album: Album) => {
    const decorated = albumTracksInOrder(album).map((t) => decorateTrack(t, album));
    if (decorated.length) handlePlayTrack(decorated[0], decorated, 0);
  };
  // Continue through the grid order after this album so list and grid playback agree.
  const playFromAlbum = (album: Album) => {
    const firsts: number[] = [];
    const all = scopedAlbums.flatMap((a) => {
      const songs = albumTracksInOrder(a).map((t) => decorateTrack(t, a));
      firsts.push(songs.length);
      return songs;
    });
    const at = scopedAlbums.indexOf(album);
    if (at < 0) return playAlbum(album);
    const start = firsts.slice(0, at).reduce((sum, n) => sum + n, 0);
    // The whole library is the list (what shuffle draws from), starting here.
    if (start < all.length) handlePlayTrack(all[start], all, start);
  };
  // Which album the playing song is on; the grid keeps that card's disc.
  const { sortedAlbums, albumIdOf } = view;
  const albumOfPath = useMemo(() => albumIdByPath(sortedAlbums, albumIdOf), [sortedAlbums, albumIdOf]);
  const playingAlbumId = selectedTrack ? albumOfPath.get(selectedTrack.path) || null : null;

  const [albumCtx, setAlbumCtx] = useState<AlbumMenu>({ open: false, x: 0, y: 0, album: null });
  const openAlbumCtx = (album: Album, e: React.MouseEvent) => {
    e.preventDefault();
    setAlbumCtx({ open: true, ...menuPointFrom(e), album });
    playlistMenu.refresh();
  };
  const ctxAlbum = albumCtx.album;
  const albumSongs = ctxAlbum ? albumTracksInOrder(ctxAlbum) : [];
  const albumSongMenu = useSongMenu(albumSongs, { showSuccess, showError, onChanged: onLibraryChanged });
  const albumCtxItems = ctxAlbum ? albumSongMenu.build({
    selection: true,
    onPlay: () => playAlbum(ctxAlbum),
    onPlayNext: () => addNextInQueue(albumSongs.map(tr => decorateTrack(tr, ctxAlbum))),
    onQueue: () => addToQueue(albumSongs.map(tr => decorateTrack(tr, ctxAlbum))),
    playlistSubmenu: playlistMenu.submenu(albumSongs),
    onOpenAlbum: () => openAlbum(ctxAlbum),
    onGoToArtist: () => openLibraryArtist(primaryArtist(ctxAlbum.artist)),
    artistDisabled: !ctxAlbum.artist,
    onOpenLyrics: undefined,
  }) : [];

  // The rows are memoized (AlbumTrackRow), which only pays off if their
  // callback props keep their identity across renders. The handlers below are
  // plain functions recreated every render, so the rows get stable wrappers
  // that read the latest one from a ref at call time.
  const latestHandlers = useRef(null as {
    openCtx: typeof openCtx;
    downloadToThisDevice: typeof downloadToThisDevice;
    decorateTrack: typeof decorateTrack;
    handlePlayTrack: typeof handlePlayTrack;
    select: typeof selection.click;
  } | null);
  latestHandlers.current = { openCtx, downloadToThisDevice, decorateTrack, handlePlayTrack, select: selection.click };
  const rowHandlers = useMemo(
    () => ({
      onContextMenu: (track: Song, e: React.MouseEvent) => latestHandlers.current.openCtx(track, e),
      onSelect: (track: Song, e: React.MouseEvent) => latestHandlers.current.select(track, e),
      onOpenAlbum: (track: Song) => openLibraryAlbum(track.album && typeof track.album === "object" ? track.album : track),
      onOpenArtist: openLibraryArtist,
      onDownload: (track: Song) => latestHandlers.current.downloadToThisDevice(track),
      // `playList` is the list the row sits in (the flat sort, or an album's
      // tracks) and `playAlbum` the album to decorate with; `null` in the flat
      // view, where each track carries its own.
      onPlay: (track: Song, playList: Song[] | undefined, playAlbum: Album | null) => {
        const { decorateTrack: decorate, handlePlayTrack: playFrom } = latestHandlers.current;
        const list = Array.isArray(playList) ? playList : [track];
        const decorated = list.map((t) => decorate(t, playAlbum || t.album));
        const startIndex = decorated.findIndex((t) => t.path === track.path);
        playFrom(track, decorated, startIndex >= 0 ? startIndex : 0);
      },
    }),
    []
  );

  // Everything a row needs that does not depend on which list it sits in.
  const rowProps = (track: Song) => ({
    // One i18n subscription for the panel instead of one for every row. This
    // scalar changes on a language switch so memoized rows still refresh.
    language: i18n.resolvedLanguage || i18n.language,
    selected: selection.isSelected(track),
    isActive: selectedTrack?.path === track.path,
    searchQuery,
    highlightMatches,
    onSelect: rowHandlers.onSelect,
    onOpenAlbum: rowHandlers.onOpenAlbum,
    onOpenArtist: rowHandlers.onOpenArtist,
    onOpenAnalysis,
    onContextMenu: rowHandlers.onContextMenu,
    onDownload: rowHandlers.onDownload,
    onPlay: rowHandlers.onPlay,
    downloadedOnDevice: isDownloaded(track),
  });

  // Which columns the user switched off; the class list hides them in CSS.
  const columnsState = useSongTableColumns();
  const emptyColumns = useEmptySongColumns(sortedFlat, view.lyricStates.states);

  return (
    <>
      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {/*  track table  */}
        <EmptySongColumnsContext.Provider value={emptyColumns}>
        <div className={`retro-song-table library-table relative flex flex-col flex-1 min-h-0 ${songTableRootClass(columnsState, filters.lyric !== "all" && !emptyColumns.includes("lyrics"), "library", emptyColumns)}`}>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            // Focusable so ⌘A / Esc / ↑↓ reach the selection once a row is clicked.
            tabIndex={-1}
            onKeyDown={(e) => {
              if ((e.target as Element).closest(".library-toolbar, .library-sticky-stack")) return;
              const reveal = selection.onKeyDown(e);
              if (reveal) {
                // By index: a virtual list may not have that row in the DOM yet.
                const index = sortedFlat.findIndex((track) => track.path === reveal);
                if (index >= 0) rowsRef.current?.scrollToIndex(index);
              }
            }}
            onMouseDown={(e) => {
              // A click on a row focuses the list (for the keys above); a
              // click on the empty space under the rows clears the selection.
              // The scrollbar belongs to this element too: a press past its
              // client width is on the scrollbar, and must never clear.
              const el = e.currentTarget;
              const target = e.target as Element;
              if (target.closest(".library-toolbar, .library-sticky-stack")) return;
              const onScrollbar = e.clientX >= el.getBoundingClientRect().left + el.clientWidth;
              if (!onScrollbar && !target.closest?.(".retro-song-table__row")) {
                if (target === el || target.closest?.(".retro-song-table__empty")) selection.clear();
              }
              scrollRef.current?.focus({ preventScroll: true });
            }}
            className="library-scroll flex-1 min-h-0 overflow-y-auto slim-scrollbar outline-none"
            // Disable scroll anchoring: virtual spacer growth must not move the requested offset.
            style={{ background: "none", overflowAnchor: "none" }}
          >
            <div className="library-scroll__content">
              <div ref={toolbarRef}>
                <LibraryFiltersToolbar
                  view={view}
                  scoped={scope.scoped}
                  canScope={scope.canScope}
                  onScope={scope.setScope}
                  serverCount={view.stems.counts.all}
                  mineCount={scope.mineCount}
                  accountName={scope.accountName}
                  owner={scope.owner}
                  people={scope.people}
                  selectedId={scope.selectedId}
                  reloading={reloading}
                  onReload={reload}
                  searchRef={searchRef}
                />
              </div>
              <div ref={sentinelRef} className="library-sticky-sentinel" aria-hidden="true" />
              <div ref={stackRef} className="library-sticky-stack">
                <LibraryFiltersActive view={view} count={sortedFlat.length} total={scope.scoped ? scope.mineCount : view.stems.counts.all} />
                {layout === "list" && <SongTableHeader sortField={sort.field} sortDir={sort.dir} onSort={view.sortByColumn} />}
              </div>
              <div ref={rowsStartRef}>
                {layout === "grid" ? (
                  <AlbumGrid
                    albums={scopedAlbums}
                    albumIdOf={view.albumIdOf}
                    playingAlbumId={playingAlbumId}
                    isPlaying={isPlaying}
                    onOpen={openAlbum}
                    onPlay={playFromAlbum}
                    onTogglePlay={() => setIsPlaying(!isPlaying)}
                    onContextMenu={openAlbumCtx}
                    scrollRef={scrollRef}
                  />
                ) : sortedFlat.length === 0 ? (
                  <p className="retro-song-table__empty">{t("No song matches")}</p>
                ) : (
                  <SongRows
                    items={sortedFlat}
                    scrollRef={scrollRef}
                    rowHeight={rowHeight}
                    handleRef={rowsRef}
                    initialOffset={savedScrollTop()}
                    scrollMargin={scrollMargin}
                    scrollPaddingStart={stackHeight}
                    renderRow={(track, trackIndex, key) => (
                      <AlbumTrackRow
                        key={key}
                        lyricState={view.lyricStates.states[lyricsKeyOf(track) || ""] || "none"}
                        track={track}
                        album={track.album}
                        showCovers={columnsState.covers.library}
                        index={trackIndex}
                        number={trackIndex + 1}
                        {...rowProps(track)}
                        playList={sortedFlat}
                        playAlbum={null}
                      />
                    )}
                  />
                )}
              </div>
            </div>
          </div>

          <SelectionBar
            scrollRef={scrollRef}
            tracks={selection.selected}
            count={layout === "list" ? selection.count : 0}
            onPlay={() => playSongs(selection.selected)}
            onPlayNext={() => addNextInQueue(decorateAll(selection.selected))}
            onQueue={() => addToQueue(decorateAll(selection.selected))}
            playlistItems={playlistMenu.submenu(selection.selected)}
            onClear={selection.clear}
          />
        </div>
        </EmptySongColumnsContext.Provider>
      </div>

      <TrackContextMenu
        open={ctx.open}
        x={ctx.x}
        y={ctx.y}
        title={ctxTrack?.title}
        artist={ctxTrack?.artist || ctxTrack?.album?.artist || ""}
        items={ctxItems}
        onClose={closeCtx}
      />
      <TrackContextMenu
        open={albumCtx.open}
        x={albumCtx.x}
        y={albumCtx.y}
        title={ctxAlbum?.album}
        artist={ctxAlbum?.artist || ""}
        items={albumCtxItems}
        onClose={() => setAlbumCtx((c) => ({ ...c, open: false }))}
      />

      <LyricsModal
        open={!!lyricsTrack}
        relPath={lyricsKeyOf(lyricsTrack)}
        track={lyricsTrack}
        onClose={() => setLyricsTrack(null)}
      />
    </>
  );
}
