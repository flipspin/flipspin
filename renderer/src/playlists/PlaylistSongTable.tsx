import { createPortal } from "react-dom";
import { reorderDisabledReason } from "./reorder";
import { usePlaylistDrag } from "./hooks/usePlaylistDrag";
import "./playlists.css";
import React, { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref, type RefObject } from "react";
import { albumDirName, parseTrackPath } from "@lib/api";
import { useTranslation } from "react-i18next";
import { ArrowDownWideNarrow, LayoutGrid, List, SquareCheck } from "lucide-react";
import { Popover } from "../ui/react/components/Popover";
import { msg } from "../i18n";
import CollapsibleSearch from "../ui/components/CollapsibleSearch";
import ColumnPicker from "../ui/components/ColumnPicker";
import SongRows, { type SongRowsHandle } from "../albums/SongRows";
import AlbumTrackRow from "../albums/AlbumTrackRow";
import { openLibraryAlbum, openLibraryArtist } from "../browse/navigationStore";
import SongTableHeader from "../library/tracks/SongTableHeader";
import { highlightMatches } from "../ui/components/highlightMatches";
import { EmptySongColumnsContext, songTableRootClass, useEmptySongColumns, useSongTableColumns } from "../library/tracks/songTableColumns";
import { toRow, type LibraryAlbum, type PlaylistTrack } from "./playlistTracks";
import { useLyricStates } from "../lyrics/lyricStates";
import { lyricsKeyOf } from "../lyrics/lyricsStore";
import { PlaylistSongGrid } from "./PlaylistGrid";
import { setPlaylistViewMode, usePlaylistViewMode } from "./playlistViewMode";

type Props = {
  /** The songs as shown: filtered and sorted. */
  tracks: PlaylistTrack[];
  albums?: LibraryAlbum[];
  scrollRef?: RefObject<HTMLDivElement | null>;
  rowsRef?: Ref<SongRowsHandle>;
  initialOffset?: number;
  onSearch?: (query: string) => void;
  onSearchActivate?: () => void;
  onClearSort?: () => void;
  onStartSelection?: () => void;
  selectionBar?: ReactNode;
  canEdit?: boolean;
  onMove?: (tracks: PlaylistTrack[], moving: PlaylistTrack[]) => void;
  /** Whether the list has any songs at all (picks the empty sentence). */
  isEmpty: boolean;
  /** The list's own colour and the ink on it, for the column header. */
  headColor: string | null;
  headInk: string | null;
  sortField: string | null;
  sortDir: string;
  onSort: (field: string) => void;
  searchQuery: string;
  activePath: string | null;
  isPlaying?: boolean;
  onTogglePlay?: () => void;
  menuPath?: string | null;
  selectionMode?: boolean;
  isSelected: (track: PlaylistTrack) => boolean;
  onSelect: (track: PlaylistTrack, e: React.MouseEvent) => void;
  onPlay: (track: PlaylistTrack) => void;
  onOpenAnalysis: (row: PlaylistTrack) => void;
  onContextMenu: (track: PlaylistTrack, e: React.MouseEvent) => void;
};

/**
 * One sticky stack inside the page scroller. The frame never clips it.
 */
const SORTS = [
  ["title", msg("Title")], ["artist", msg("Artist")], ["album", msg("Album")],
  ["genre", msg("Genre")], ["date", msg("Date")], ["key", msg("Key_tone")], ["bpm", "BPM"], ["duration", msg("Duration")],
];

export default function PlaylistSongTable({
  tracks,
  albums,
  scrollRef,
  rowsRef,
  initialOffset = 0,
  onSearch,
  onSearchActivate,
  onClearSort,
  onStartSelection,
  selectionBar,
  canEdit = false,
  onMove,
  isEmpty,
  headColor,
  headInk,
  sortField,
  sortDir,
  onSort,
  searchQuery,
  activePath,
  isPlaying = false,
  onTogglePlay,
  menuPath,
  selectionMode,
  isSelected,
  onSelect,
  onPlay,
  onOpenAnalysis,
  onContextMenu,
}: Props) {
  const { t } = useTranslation();
  const columnsState = useSongTableColumns();
  const lyricStates = useLyricStates();
  const emptyColumns = useEmptySongColumns(tracks, lyricStates.states);
  const viewMode = usePlaylistViewMode();
  const grid = viewMode === "grid";
  const showCovers = columnsState.covers.playlist;
  // Join by the media directory, never by title or artist (both can repeat).
  const albumsByDir = useMemo(() => new Map((albums ?? []).map(album => [albumDirName(album), album])), [albums]);
  const albumsByPath = useMemo(() => new Map((albums ?? []).flatMap(album => (album.tracks ?? []).map(track => [track.path, album] as const))), [albums]);
  const localScroll = useRef<HTMLDivElement>(null);
  const scroller = scrollRef ?? localScroll;
  const root = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const rows = useRef<SongRowsHandle>(null);
  React.useImperativeHandle(rowsRef, () => ({ scrollToIndex: index => rows.current?.scrollToIndex(index) }), []);
  const picker = useRef<{ open: () => void }>(null);
  const sortButton = useRef<HTMLButtonElement>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [metrics, setMetrics] = useState({ margin: 0, stack: 0, row: 44 });
  useLayoutEffect(() => {
    const table = root.current;
    const list = body.current;
    // A parent's ref attaches after its children's layout effects on mount.
    // Resolve the scroll owner from the committed DOM for that first measure.
    let page = scroller.current ?? table?.parentElement;
    while (page?.parentElement && !/(auto|scroll)/.test(getComputedStyle(page).overflowY)) page = page.parentElement;
    if (!page || !table || !list) return;
    if (!scrollRef) localScroll.current = page as HTMLDivElement;
    const toolbar = stack.current?.querySelector<HTMLElement>(".playlist-table-tools");
    const syncSearchOverlay = () => {
      if (!toolbar) return;
      const overlay = toolbar.clientWidth > 0 && toolbar.clientWidth < 300 && Boolean(toolbar.querySelector(".collapsible-search[data-open]:not([data-suspended])"));
      toolbar.toggleAttribute("data-search-overlay", overlay);
      toolbar.querySelectorAll<HTMLElement>(":scope > .playlist-table-tool, :scope > .song-table-columns").forEach(control => { control.inert = overlay; });
    };
    const measure = () => {
      syncSearchOverlay();
      const height = stack.current?.offsetHeight ?? 0;
      const margin = list.getBoundingClientRect().top - page.getBoundingClientRect().top - page.clientTop + page.scrollTop;
      const row = list.querySelector<HTMLElement>(".retro-song-table__row")?.offsetHeight || 44;
      page.style.setProperty("--stack-h", `${height}px`);
      table.style.setProperty("--stack-h", `${height}px`);
      setMetrics(old => old.margin === margin && old.stack === height && old.row === row ? old : { margin, stack: height, row });
    };
    measure();
    const mutations = new MutationObserver(syncSearchOverlay);
    if (toolbar) mutations.observe(toolbar, { subtree: true, attributes: true, attributeFilter: ["data-open", "data-suspended"], childList: true });
    if (typeof ResizeObserver === "undefined") return () => mutations.disconnect();
    const observer = new ResizeObserver(measure);
    observer.observe(page);
    observer.observe(table);
    if (stack.current) observer.observe(stack.current);
    const band = page.querySelector(".playlist-band-anchor");
    if (band) observer.observe(band);
    return () => { observer.disconnect(); mutations.disconnect(); };
  }, [scroller, scrollRef, showCovers, tracks.length, grid]);
  const reason = reorderDisabledReason(canEdit, sortField, searchQuery);
  const { drag, start, resetClick, captureClick } = usePlaylistDrag(tracks, !grid && !reason && !!onMove, isSelected, onMove, index => rows.current?.scrollToIndex(index));
  const numberTitle = reason === "sort" ? t("Clear column sorting to move songs") : reason === "search" ? t("Clear the search to move songs") : undefined;
  const headStyle = headColor
    ? ({ "--song-table-head": headColor, "--song-table-head-ink": headInk } as CSSProperties)
    : undefined;

  return (
    <EmptySongColumnsContext.Provider value={emptyColumns}>
    <div ref={root} className={`retro-song-table retro-song-table--embedded playlist-songs playlist-song-card flex flex-col flex-[1_0_auto] ${songTableRootClass(columnsState, false, "playlist", emptyColumns)}`} style={headStyle}>
        <div ref={stack} className="playlist-song-stack">
          <div className="playlist-table-tools" role="toolbar" aria-label={t("Table tools")}>
            {selectionBar || <>
              <button ref={sortButton} type="button" className="playlist-table-tool" aria-label={t("Sort")} title={t("Sort")}
                aria-haspopup="menu" aria-expanded={sortOpen} onClick={() => setSortOpen(!sortOpen)}><ArrowDownWideNarrow size={16} aria-hidden /></button>
              {/* One switch, two positions: a segmented control, not two loose icons. */}
              <span className="playlist-view-toggle" role="group" aria-label={t("View_noun")}>
                <button type="button" className="playlist-view-toggle__opt" aria-label={t("List")} title={t("List")} aria-pressed={!grid} onClick={() => setPlaylistViewMode("list")}><List size={15} aria-hidden /></button>
                <button type="button" className="playlist-view-toggle__opt" aria-label={t("Covers")} title={t("Covers")} aria-pressed={grid} onClick={() => setPlaylistViewMode("grid")}><LayoutGrid size={15} aria-hidden /></button>
              </span>
              <span className="playlist-table-tools__spacer" />
            </>}
            <CollapsibleSearch value={searchQuery} onChange={onSearch ?? (() => {})} label={t("Search playlist")} suspended={Boolean(selectionBar)} onActivate={onSearchActivate} />
            {!selectionBar && <button type="button" className="playlist-table-tool" aria-label={t("Select songs")} title={t("Select songs")} onClick={onStartSelection}><SquareCheck size={16} aria-hidden /></button>}
            <ColumnPicker kind="playlist" handleRef={picker} hidden={grid || Boolean(selectionBar)} />
          </div>
          {!grid && <SongTableHeader kind="playlist" numberTitle={numberTitle} columnPicker={false} onColumns={() => picker.current?.open()} sortField={sortField} sortDir={sortDir} onSort={onSort} />}
        </div>
        <Popover open={sortOpen} onClose={() => setSortOpen(false)} anchorRef={sortButton} placement="bottom-start" role="menu" aria-label={t("Sort")} className="playlist-sort-menu">
          <button type="button" role="menuitemradio" aria-checked={!sortField} onClick={() => { onClearSort?.(); setSortOpen(false); }}>{t("Playlist order")}</button>
          {SORTS.map(([field, label]) => <button key={field} type="button" role="menuitemradio" aria-checked={sortField === field} onClick={() => { onSort(field); setSortOpen(false); }}>{t(label)}{sortField === field ? sortDir === "desc" ? " ↓" : " ↑" : ""}</button>)}
        </Popover>
        <div ref={body} className="playlist-song-rows flex-[1_0_auto]">
          {tracks.length === 0 ? (
            <p className="text-center text-gray-500 p-4">
              {isEmpty ? t("This playlist is empty") : t("No song matches the search")}
            </p>
          ) : grid ? (
            <PlaylistSongGrid tracks={tracks} albums={albums} scrollRef={scroller} rowsRef={rows}
              initialOffset={scroller.current?.scrollTop ?? initialOffset} scrollPaddingStart={metrics.stack}
              activePath={activePath} isPlaying={isPlaying} onTogglePlay={onTogglePlay} menuPath={menuPath}
              selectionMode={selectionMode} isSelected={isSelected} onSelect={onSelect} onPlay={onPlay} onContextMenu={onContextMenu} />
          ) : (
            <SongRows items={tracks} scrollRef={scroller} rowHeight={metrics.row} scrollMargin={metrics.margin} scrollPaddingStart={metrics.stack}
              handleRef={rows} initialOffset={scroller.current?.scrollTop ?? initialOffset}
              listProps={{ className: "playlist-reorder", onPointerDownCapture: resetClick, onClickCapture: captureClick, onDoubleClickCapture: captureClick }}
              afterRows={drag && <li aria-hidden="true" className="playlist-reorder__drop" style={{ top: drag.line }} />}
              renderRow={(track, trackIndex, key) => {
                const { rowTrack, albumName, artistName } = toRow(track);
                const dir = parseTrackPath(track.path).albumName;
                const album = albumsByPath.get(track.path) ?? albumsByDir.get(dir) ?? (typeof track.album === "object" ? track.album : null);
                return (
                  <AlbumTrackRow
                    key={key}
                    lyricState={lyricStates.states[lyricsKeyOf(track) || ""] || "none"}
                    rowClassName={drag?.moving.some(song => song.path === track.path) ? "playlist-reorder__lifted" : ""}
                    leadingCell={!reason && onMove ? <>
                      <span className="playlist-reorder__number">{String(trackIndex + 1).padStart(2, "0")}</span>
                      <button type="button" className="song-row__action playlist-reorder__grip" title={t("Drag to move")} aria-label={t("Move {{title}}", { title: track.title })} onPointerDown={e => start(track, e)}>⠿</button>
                    </> : undefined}
                    track={rowTrack}
                    album={{ ...album, mediaKey: album?.mediaKey || (album?.path ? albumDirName(album) : dir), album: albumName, artist: artistName }}
                    showCovers={showCovers}
                    index={trackIndex}
                    number={trackIndex + 1}
                    selected={isSelected(track)}
                    isActive={activePath === track.path}
                    searchQuery={searchQuery}
                    highlightMatches={highlightMatches}
                    onSelect={(_t, e) => onSelect(track, e)}
                    onOpenAlbum={() => openLibraryAlbum(track, albumName)}
                    onOpenArtist={openLibraryArtist}
                    onPlay={() => onPlay(track)}
                    onOpenAnalysis={() => onOpenAnalysis(rowTrack)}
                    onContextMenu={onContextMenu}
                    // Library-only: one panel-wide i18n scalar, the stable
                    // list callbacks and the device download cell.
                    language={undefined}
                    playList={undefined}
                    playAlbum={undefined}
                    onDownload={undefined}
                  />
                );
              }}
            />
          )}
        </div>
      {drag && createPortal(<div className="playlist-reorder__ghost" aria-hidden="true" style={{ left: drag.x + 16, top: drag.y + 16 }}><b>{drag.moving.length}</b><span>{drag.moving[0]?.title}</span>{drag.moving.length > 1 && <small>+ {drag.moving.length - 1}</small>}</div>, document.body)}
    </div>
    </EmptySongColumnsContext.Provider>
  );
}
