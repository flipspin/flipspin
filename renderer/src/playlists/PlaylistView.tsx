import { SONG_ACTION_COLOR } from "../library/tracks/songMenuItems";
import { useSongMenu } from "../library/tracks/useSongMenu";
import { useTrackPresence } from "../library/trackPresence";
import { openBulkTags } from "../library/tracks/bulkTagStore";
import RemovalButtons from "../acquisition/RemovalButtons";
import { isRealUser, useIdentity } from "@state/identityStore";
import { canEditPlaylist, reorderDisabledReason } from "./reorder";
import { reorderMenu } from "./reorderMenu";
import React, { useState, useCallback, useMemo, useRef, useLayoutEffect } from "react";
import { useAudioPlayer } from "@state/AudioPlayerContext";
import { useSettings } from "@state/SettingsContext";
import { useStatus } from "../state/useStatus";
import { usePlaylistTransfer } from "./hooks/usePlaylistTransfer";
import { usePlaylistData } from "./hooks/usePlaylistData";
import { usePlaylistEditing } from "./hooks/usePlaylistEditing";
import { useStatusAutoClear } from "./hooks/useStatusAutoClear";
import { useAlbumActions } from "../albums/hooks/useAlbumActions";
import { useSongSelection } from "../library/tracks/useSongSelection";
import { ArrowDown, Ellipsis, ListEnd, ListStart, Play } from "lucide-react";
import { useHeaderTitle } from "../shell/headerTitle";
import { useOffline } from "../offline/useOffline";
import { hasBridge } from "../bridge";
import { relPathOf } from "@state/userLibraryStore";
import { isDownloaded, refreshOffline, useOffline as useOfflineFiles } from "../acquisition/offline";
import { pinTracks } from "../acquisition/libraryActions";
import type { SongRowsHandle } from "../albums/SongRows";
import PlaylistHero, { playlistCovers } from "./PlaylistHero";
import PlaylistSongTable from "./PlaylistSongTable";
import PlaylistErrorBoundary from "./PlaylistErrorBoundary";
import { playlistColor, playlistInk } from "./playlistBadge";
import { filterTracks, toQueueTrack, withLibraryMeta, type LibraryAlbum, type PlaylistTrack } from "./playlistTracks";
import { ExplorePanel } from "../browse/ExplorePanel";
import PlaylistGrid from "./PlaylistGrid";
import { useTableSort, sortTracks } from "../ui/components/useTableSort";
import { TrackInfoHost } from "../library/tracks/TrackInfoModal";
import { openTrackInfo } from "../library/tracks/trackInfoStore";
import TrackContextMenu, { menuPointFrom, type MenuItem } from "../albums/TrackContextMenu";
import { useAddToPlaylistMenu } from "../library/tracks/useAddToPlaylistMenu";
import LyricsModal from "../lyrics/LyricsModal";
import { lyricsKeyOf } from "../lyrics/lyricsStore";
import { useTranslation } from "react-i18next";
import { useRemoveActions } from "../acquisition/removeActions";

type Props = {
  albums: LibraryAlbum[];
  selectedPlaylistName: string | null;
  setSelectedPlaylistName?: (name: string | null) => void;
  backendOnline?: boolean | null;
};

type MenuState = { open: boolean; x: number; y: number; track: PlaylistTrack | null; songs?: PlaylistTrack[] };

const scrollPositions = new Map<string, number>();

function PlaylistViewInner({ albums, selectedPlaylistName, setSelectedPlaylistName, backendOnline }: Props) {
  const present = useTrackPresence();
  const { t } = useTranslation();
  const identity = useIdentity();
  const [moveAnnouncement, setMoveAnnouncement] = useState({ text: "", id: 0 });
  const { selectedTrack, isPlaying, setIsPlaying, shuffleEnabled = false, toggleShuffle, play, addNextInQueue, addToQueue } = useAudioPlayer();

  const [searchQuery, setSearchQuery] = useState("");
  const [ctx, setCtx] = useState<MenuState>({ open: false, x: 0, y: 0, track: null });
  const [lyricsTrack, setLyricsTrack] = useState<PlaylistTrack | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<SongRowsHandle>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLSpanElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const routeKey = `#/playlists/${selectedPlaylistName ?? ""}`;
  const initialOffset = scrollPositions.get(routeKey) ?? 0;
  const currentPlaylistName = useRef(selectedPlaylistName);
  currentPlaylistName.current = selectedPlaylistName;
  const { vlcIp } = useSettings();
  const { status, showInfo, showSuccess, showError, clear } = useStatus();
  useStatusAutoClear(status, clear);

  const {
    playlists,
    playlistsLoaded,
    loadedFor,
    selectedPlaylist,
    setSelectedPlaylist,
    playlistTracks,
    setPlaylistTracks,
    errorMessage,
    loadPlaylists,
    loadPlaylistTracks,
  } = usePlaylistData({ albums, selectedPlaylistName, backendOnline });

  const editing = usePlaylistEditing({
    selectedPlaylist,
    selectedPlaylistName,
    setSelectedPlaylistName,
    playlistTracks,
    setPlaylistTracks,
    setSelectedPlaylist,
    loadPlaylists,
    showSuccess,
    showError,
  });
  const { removeSongs } = editing;

  // Render songs only when they belong to the requested playlist so a route change cannot flash stale content.
  const showing = Boolean(selectedPlaylist) && loadedFor === selectedPlaylistName;
  // The table header wears the list's own colour; the one on its initials
  // badge in the sidebar, the grid and Home; with dark text like the badge,
  // or cream when that colour is very dark.
  const headColor = showing ? playlistColor(selectedPlaylistName) : null;
  const headInk = useMemo(() => (headColor ? playlistInk(selectedPlaylistName) : null), [headColor, selectedPlaylistName]);

  const tracksWithMeta = useMemo(() => withLibraryMeta(playlistTracks, albums), [playlistTracks, albums]);
  const filteredTracks = useMemo(() => filterTracks(tracksWithMeta, searchQuery), [tracksWithMeta, searchQuery]);

  const { sortField, sortDir, toggleSort, clearSort } = useTableSort();
  const sortedTracks: PlaylistTrack[] = useMemo(
    () => sortTracks(filteredTracks, sortField, sortDir),
    [filteredTracks, sortField, sortDir]
  );
  // Selection: click / ⌘ / Shift / ⌘A / Esc / arrows; shared with the Library.
  const selection = useSongSelection(sortedTracks);
  const canEdit = canEditPlaylist(selectedPlaylist?.owner, identity);
  const canReorder = !editing.saving && !reorderDisabledReason(canEdit, sortField, searchQuery);
  const moveSongs = async (tracks: PlaylistTrack[], moving: PlaylistTrack[]) => {
    if (!canReorder) return;
    // Map visible enriched rows back to the stored songs; only order changes.
    const byPath = new Map(playlistTracks.map(song => [song.path, song]));
    const next = tracks.map(song => byPath.get(song.path)!);
    if (next.every((song, index) => song.path === playlistTracks[index]?.path)) return;
    const saved = await editing.updatePlaylistTracks(next);
    if (saved && currentPlaylistName.current === selectedPlaylistName) {
      const paths = new Set(moving.map(song => song.path));
      const first = next.findIndex(song => paths.has(song.path));
      const text = moving.length === 1
        ? t("{{title}} moved to position {{position}} of {{total}}", { title: moving[0].title, position: first + 1, total: next.length })
        : t("{{n}} songs moved to position {{position}} of {{total}}", { n: moving.length, position: first + 1, total: next.length });
      setMoveAnnouncement(previous => ({ text, id: previous.id + 1 }));
    }
  };

  const { handleRefreshPlaylist } = usePlaylistTransfer(
    selectedPlaylist,
    { showInfo, showSuccess, showError },
    loadPlaylistTracks,
  );
  const { sendItems } = useAlbumActions({ vlcIp });

  const buildQueueTrack = useCallback((track: PlaylistTrack) => toQueueTrack(track, albums), [albums]);

  const playTrack = useCallback((track: PlaylistTrack, list?: PlaylistTrack[]) => {
    if (!track) return;
    const sourceList = (list && list.length ? list : playlistTracks) || [track];
    const built = sourceList.filter(present).map(buildQueueTrack);
    const current = built.find((t) => t.path === track.path) || buildQueueTrack(track);
    const idx = built.findIndex((t) => t.path === track.path);
    const upcomingTracks = idx >= 0 ? built.slice(idx + 1) : built.filter((t) => t.path !== track.path);
    const source = selectedPlaylistName ? { kind: "playlist" as const, name: String(selectedPlaylistName) } : undefined;
    play(current, { replaceQueue: true, upcomingTracks, context: built, source });
  }, [playlistTracks, buildQueueTrack, play, selectedPlaylistName, present]);

  // "Add to another playlist": the same submenu as Library, minus this list.
  const playlistMenu = useAddToPlaylistMenu({ showSuccess, showError, exclude: selectedPlaylistName });

  //  right-click context menu (mirrors the library track rows)
  const openCtx = (track: PlaylistTrack, e: React.MouseEvent) => {
    e.preventDefault();
    // A row inside a selection acts on the selection; any other row alone.
    const songs = selection.forRow(sortedTracks.find((x) => x.path === track.path) || track);
    setCtx({ open: true, ...menuPointFrom(e), track, songs });
    playlistMenu.refresh();
  };
  const closeCtx = () => setCtx((c) => ({ ...c, open: false }));

  const strip = useMemo(() => showing && selectedPlaylistName ? {
    name: selectedPlaylistName,
    coverUrl: playlistCovers(selectedPlaylist, playlistTracks)[0] ?? null,
    color: headColor!, ink: headInk!, collapsed,
    play: sortedTracks.length ? () => playTrack(sortedTracks[0], sortedTracks) : null,
  } : null, [showing, selectedPlaylistName, selectedPlaylist, playlistTracks, headColor, headInk, collapsed, sortedTracks, playTrack]);
  useHeaderTitle(strip);

  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page) return;
    // A route may load asynchronously: do not replace its saved offset with
    // the loading surface's zero before SongRows receives initialOffset.
    page.scrollTop = selectedPlaylistName && !showing ? 0 : scrollPositions.get(routeKey) ?? 0;
    if (!showing) { setCollapsed(false); return; }
    const band = bandRef.current;
    const sentinel = sentinelRef.current;
    const title = band?.querySelector<HTMLElement>(".playlist-band__title");
    if (!band || !sentinel || !title) return;
    const set = (value: boolean) => {
      if (page.dataset.collapsed === String(value)) return;
      page.dataset.collapsed = String(value);
      setCollapsed(value);
    };
    const measure = () => {
      const bottom = title.getBoundingClientRect().bottom;
      sentinel.style.top = `${bottom - band.getBoundingClientRect().top}px`;
      set(bottom + 16 <= page.getBoundingClientRect().top + page.clientTop);
    };
    measure();
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0)) set(true);
        else if (entry.intersectionRatio === 1) set(false);
      }
    }, { root: page, threshold: [0, 1] });
    observer?.observe(sentinel);
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resize?.observe(band);
    resize?.observe(title);
    resize?.observe(page);
    return () => { observer?.disconnect(); resize?.disconnect(); };
  }, [routeKey, showing, selectedPlaylistName, editing.renaming]);

  const clearSelection = () => { selection.clear(); setSelecting(false); };
  const offline = useOffline();
  const selectionKeys = [...new Set(selection.selected.map(relPathOf).filter((key): key is string => !!key))];
  const selectionRemovals = useRemoveActions(selection.selected, clearSelection);
  const selectionFiles = useOfflineFiles(selectionKeys);
  const toDownload = selectionKeys.filter(key => !isDownloaded(selectionFiles[key]));
  const [downloadingSelection, setDownloadingSelection] = useState(false);
  const downloadReason = !isRealUser(identity) ? t("Sign in to your account to add and download.")
    : !hasBridge() ? t("Downloading requires the desktop app.")
    : offline ? t("Disconnected from the nest")
    : !toDownload.length ? t("Already downloaded on this computer") : "";
  const downloadSelection = async () => {
    setDownloadingSelection(true);
    try {
      for (const key of toDownload) await pinTracks("song", key, [key]);
      await refreshOffline();
      clearSelection();
    } catch { showError(t("Could not download")); }
    finally { setDownloadingSelection(false); }
  };
  const ctxTrack = ctx.track;
  const ctxSongs = ctx.songs || [];
  const songMenu = useSongMenu(ctxSongs, { showSuccess, showError, onChanged: selection.clear });
  const queueOf = (songs: PlaylistTrack[]) => songs.filter(present).map(buildQueueTrack);
  const playableTracks = sortedTracks.filter(present);
  const playSongs = (songs: PlaylistTrack[]) => {
    const playable = songs.filter(present);
    if (playable.length) playTrack(playable[0], playable);
  };
  const removeItem = (songs: PlaylistTrack[]): MenuItem => ({
    label: songs.length > 1 ? t("Remove {{n}} from playlist", { n: songs.length }) : t("Remove from playlist"),
    color: SONG_ACTION_COLOR.remove,
    danger: true,
    disabled: !canEdit || editing.saving,
    onClick: () => removeSongs(songs),
  });
  const ctxItems = ctxTrack ? songMenu.build({
    onPlay: () => ctxSongs.length > 1 ? playSongs(ctxSongs) : playTrack(ctxTrack, playlistTracks),
    onPlayNext: () => addNextInQueue(queueOf(ctxSongs)),
    onQueue: () => addToQueue(queueOf(ctxSongs)),
    playlistSubmenu: playlistMenu.submenu(ctxSongs),
    onOpenLyrics: ctxSongs.length === 1 ? () => setLyricsTrack(ctxTrack) : undefined,
    playlistLabel: t("Add to another playlist"),
    afterPlaylist: reorderMenu(playlistTracks, ctxSongs, canReorder, moveSongs),
    sendSubmenu: sendItems(ctxSongs),
    extras: [removeItem(ctxSongs)],
  }) : [];

  return (
    // Let the header scroll away while the column headings stick to the page edge.
    // Keep top padding off this scroller so it cannot offset the sticky header.
    <div
      ref={pageRef}
      tabIndex={-1}
      onScroll={e => { if (!selectedPlaylistName || showing) scrollPositions.set(routeKey, e.currentTarget.scrollTop); }}
      onKeyDown={(e) => {
        const reveal = selection.onKeyDown(e);
        if (e.key === "Escape" && !(e.target as HTMLElement).closest("input, textarea")) setSelecting(false);
        if (reveal) rowsRef.current?.scrollToIndex(sortedTracks.findIndex(track => track.path === reveal));
      }}
      onMouseDown={(e) => {
        // Focus for ⌘A / Esc / ↑↓; a click on bare page (not a row, not a
        // control, not the scrollbar) clears the selection.
        const el = e.currentTarget;
        const target = e.target as Element;
        const onScrollbar = e.clientX >= el.getBoundingClientRect().left + el.clientWidth;
        const bare = !target.closest?.(".retro-song-table__row, .playlist-track-grid__song, button, input, a, [role='menu'], [role='listbox']");
        if (!onScrollbar && bare) clearSelection();
        if (!target.closest?.("input, textarea")) pageRef.current?.focus({ preventScroll: true });
      }}
      className={`playlist-page flex flex-col flex-1 min-h-0 p-6 gap-5 text-ink overflow-y-auto slim-scrollbar outline-none ${showing ? "pt-0" : ""}`}
    >
      <div className="playlist-reorder__live" aria-live="polite" aria-atomic="true"><span key={moveAnnouncement.id}>{moveAnnouncement.text}</span></div>
      {errorMessage && (
        <div className="text-sm text-white bg-[#D14B6A] px-3 py-2 rounded">
          {errorMessage}
        </div>
      )}

      {!selectedPlaylistName ? (
        // Every list, opened from the "Playlists" heading in the sidebar.
        <ExplorePanel title={t("Your playlists")} accent="var(--purple)" count={playlists.length || null}>
          <PlaylistGrid
            playlists={playlists}
            loaded={playlistsLoaded}
            onOpen={(name) => setSelectedPlaylistName?.(name)}
            onCreated={(name) => setSelectedPlaylistName?.(name)}
          />
        </ExplorePanel>
      ) : !showing ? (
        // Asked for, not here yet: an empty page rather than the grid or the
        // previous list (that flash, then a slide, is what this replaced).
        // Shown only if the load is slow (the class delays it), so a quick open
        // never flashes it.
        errorMessage ? null : <p className="playlist-loading m-0 text-[13px] text-[var(--ink-3)]">{t("Loading the playlist…")}</p>
      ) : (
        // The band moves with the page; no transformed ancestor around the stack.
        <div key={selectedPlaylistName} className="playlist-page-content flex flex-col flex-[1_0_auto]">
          <div ref={bandRef} className="playlist-band-anchor">
            <PlaylistHero
              playlist={selectedPlaylist}
              tracks={playlistTracks}
              onPlay={playableTracks.length ? () => playSongs(playableTracks) : null}
              onRefresh={handleRefreshPlaylist}
              renaming={editing.renaming}
              renameValue={editing.renameValue}
              setRenameValue={editing.setRenameValue}
              onStartRename={editing.startRename}
              onSubmitRename={editing.submitRename}
              onCancelRename={editing.cancelRename}
              onDelete={editing.deletePlaylist}
              shuffleOn={shuffleEnabled}
              onToggleShuffle={toggleShuffle}
            />
            <span ref={sentinelRef} className="playlist-title-sentinel" aria-hidden />
          </div>

          <PlaylistSongTable
            tracks={sortedTracks}
            albums={albums}
            scrollRef={pageRef}
            rowsRef={rowsRef}
            initialOffset={initialOffset}
            onSearch={setSearchQuery}
            onSearchActivate={clearSelection}
            onClearSort={clearSort}
            onStartSelection={() => setSelecting(true)}
            selectionBar={selecting || selection.count > 0 ? <>
              <span className="playlist-table-tools__count">{t("{{n}} selected", { count: selection.count, n: selection.count })}</span>
              <button type="button" className="playlist-table-tool" title={t("Play")} aria-label={t("Play selection")} disabled={!selection.count} onClick={() => playSongs(selection.selected)}><Play size={15} aria-hidden /></button>
              <button type="button" className="playlist-table-tool" title={t("Play next")} aria-label={t("Play next")} disabled={!selection.count} onClick={() => addNextInQueue(queueOf(selection.selected))}><ListStart size={16} aria-hidden /></button>
              <button type="button" className="playlist-table-tool" title={t("Add to the queue")} aria-label={t("Add to the queue")} disabled={!selection.count} onClick={() => addToQueue(queueOf(selection.selected))}><ListEnd size={16} aria-hidden /></button>
              <button type="button" className="playlist-table-tool" title={downloadReason || t("Download to this computer")} aria-label={t("Download_verb")} disabled={!!downloadReason || downloadingSelection || !selection.count} onClick={() => void downloadSelection()}><ArrowDown size={16} aria-hidden /></button>
              {selection.count > 1 && identity.me?.role === "owner" ? <button type="button" className="playlist-table-tool" disabled={offline || selectionKeys.length > 500} title={selectionKeys.length > 500 ? t("Select up to 500 songs") : t("Edit tags")} onClick={() => openBulkTags(selection.selected)}>{t("Edit tags")}</button> : null}
              <button type="button" className="playlist-table-tool" title={t("More actions")} aria-label={t("More actions")} disabled={!selection.count} onClick={e => { setCtx({ open: true, ...menuPointFrom(e), track: selection.selected[0], songs: selection.selected }); playlistMenu.refresh(); }}><Ellipsis size={16} aria-hidden /></button>
              {selectionRemovals.length > 0 && <span className="playlist-table-tools__removals">
                <RemovalButtons items={selectionRemovals} buttonClassName="playlist-table-tool" dangerClassName="playlist-table-tool--danger" ruleClassName="playlist-table-tools__rule" />
              </span>}
              <span className="playlist-table-tools__spacer" />
              <button type="button" className="playlist-table-tool playlist-table-tool--cancel" onClick={clearSelection}>{t("Cancel")} <kbd>{t("Esc")}</kbd></button>
            </> : null}
            canEdit={canEdit && !editing.saving}
            onMove={moveSongs}
            isEmpty={playlistTracks.length === 0}
            headColor={headColor}
            headInk={headInk}
            sortField={sortField}
            sortDir={sortDir}
            onSort={toggleSort}
            searchQuery={searchQuery}
            activePath={selectedTrack?.path ?? null}
            isPlaying={isPlaying}
            onTogglePlay={() => setIsPlaying(value => !value)}
            menuPath={ctx.open ? ctx.track?.path : null}
            selectionMode={selecting}
            isSelected={selection.isSelected}
            onSelect={(track, event) => selection.click(track, selecting && !event.shiftKey ? { ctrlKey: true } : event)}
            onPlay={(track) => playTrack(track, playlistTracks)}
            onOpenAnalysis={openTrackInfo}
            onContextMenu={openCtx}
          />
        </div>
      )}
      <TrackInfoHost />
      <TrackContextMenu
        open={ctx.open}
        x={ctx.x}
        y={ctx.y}
        title={ctxTrack?.title}
        artist={ctxTrack?.artist || ""}
        items={ctxItems}
        onClose={closeCtx}
      />
      <LyricsModal
        open={!!lyricsTrack}
        relPath={lyricsKeyOf(lyricsTrack)}
        track={lyricsTrack}
        onClose={() => setLyricsTrack(null)}
      />
    </div>
  );
}

export default function PlaylistView(props: Props) {
  return (
    <PlaylistErrorBoundary>
      <PlaylistViewInner key={props.selectedPlaylistName ?? "grid"} {...props} />
    </PlaylistErrorBoundary>
  );
}
