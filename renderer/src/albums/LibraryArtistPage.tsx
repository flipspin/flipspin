import { useSongMenu } from "../library/tracks/useSongMenu";
import SongTableHeader from "../library/tracks/SongTableHeader";
import { EmptySongColumnsContext, songTableRootClass, useEmptySongColumns, useSongTableColumns } from "../library/tracks/songTableColumns";
import RemovalMenu from "../acquisition/RemovalMenu";
import { useRemoveActions } from "../acquisition/removeActions";
import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Loader2, Mic2, Play, Shuffle, Telescope } from "lucide-react";
import { useAudioPlayer } from "@state/AudioPlayerContext";
import { albumStub } from "@lib/albumStub";
import { buildAlbumCoverUrl, buildMediaUrl, parseTrackPath } from "@lib/api";
import { useStatus } from "../state/useStatus";
import { search as searchCatalog } from "../browse/browseApi";
import { albumDirOf, openLibraryAlbum, openLibraryArtist, push } from "../browse/navigationStore";
import CoverTile from "../ui/components/CoverTile";
import { artColorFor } from "../ui/components/cardArt";
import { playlistInk } from "../playlists/playlistBadge";
import SelectionBar from "../ui/components/SelectionBar";
import { useSongSelection } from "../library/tracks/useSongSelection";
import { useAddToPlaylistMenu } from "../library/tracks/useAddToPlaylistMenu";
import AlbumGrid from "./AlbumGrid";
import AlbumTrackRowUntyped from "./AlbumTrackRow";
import { TrackInfoHost } from "../library/tracks/TrackInfoModal";
import { openTrackInfo } from "../library/tracks/trackInfoStore";
import TrackContextMenu, { menuPointFrom } from "./TrackContextMenu";
import { artistKey, tagNames } from "./artistMatch";
import LyricsModal from "../lyrics/LyricsModal";
import { lyricsKeyOf } from "../lyrics/lyricsStore";

/** Match artist tags through artistMatch so shared credits count consistently.
 * Keep this on the browse stack so Back returns to the song, album or player that opened it. */
const AlbumTrackRow = AlbumTrackRowUntyped as unknown as React.ComponentType<any>;
type Album = { path: string; album?: string; artist?: string; year?: string | number; cover?: string; tracks: any[] };

function formatTotal(seconds: number, t: TFunction) {
  const total = Math.round(Number(seconds) || 0);
  if (!total) return null;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h ? t("{{h}} h {{m}} min", { h, m }) : t("{{m}} min", { m });
}

const byYearThenName = (a: Album, b: Album) =>
  (Number(a.year) || 9999) - (Number(b.year) || 9999) || String(a.album || "").localeCompare(String(b.album || ""));
const byTrackNumber = (a: any, b: any) =>
  (Number(a.track_number) || Infinity) - (Number(b.track_number) || Infinity);

/** The playlist hero's cover size (PlaylistHero COVER): it follows the window. */
const HERO_COVER = "clamp(140px, 18vw, 220px)";

export default function LibraryArtistPage({ name, albums = [] }: { name: string; albums?: Album[] }) {
  const { t } = useTranslation();
  const columns = useSongTableColumns();
  const { play, addToQueue, addNextInQueue, selectedTrack, shuffleEnabled, toggleShuffle, isPlaying, setIsPlaying } = useAudioPlayer() as any;
  const { showSuccess, showError } = useStatus() as any;
  const [lyricsTrack, setLyricsTrack] = useState<any>(null);
  const [infoOpened, setInfoOpened] = useState(false);
  const [ctx, setCtx] = useState<{ open: boolean; x: number; y: number; track: any; songs: any[]; album: Album | null }>({ open: false, x: 0, y: 0, track: null, songs: [], album: null });
  const [finding, setFinding] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);

  const key = artistKey(name);
  // Their own albums (the album is credited to them), the albums they only
  // appear on, and every one of their songs in album order.
  const { own, appearsOn, songs } = useMemo(() => {
    const own: Album[] = [];
    const appearsOn: Album[] = [];
    const songs: any[] = [];
    for (const album of [...albums].sort(byYearThenName)) {
      const theirs = (album.tracks || []).filter((tr) => tagNames(tr.artist || album.artist, key));
      if (tagNames(album.artist, key)) own.push(album);
      else if (theirs.length) appearsOn.push({ ...album, tracks: theirs, totalTracks: album.tracks.length } as Album);
      songs.push(...[...theirs].sort(byTrackNumber).map((tr) => ({ ...tr, album })));
    }
    return { own, appearsOn, songs };
  }, [albums, key]);
  const emptyColumns = useEmptySongColumns(songs);

  const selection = useSongSelection(songs);
  const ctxSongs = ctx.songs || [];
  const headerRemovals = useRemoveActions(songs);
  const songMenu = useSongMenu(ctxSongs, { showSuccess, showError, onChanged: selection.clear });
  const playlistMenu = useAddToPlaylistMenu({ showSuccess, showError });

  const displayName = songs[0]?.artist && artistKey(songs[0].artist) === key ? songs[0].artist : own[0]?.artist && artistKey(own[0].artist) === key ? own[0].artist : name;
  const color = artColorFor(displayName);
  const ink = playlistInk(displayName);
  const cover = own[0] ? own[0].cover || buildAlbumCoverUrl(own[0]) : songs[0] ? songs[0].album.cover || buildAlbumCoverUrl(songs[0].album) : null;

  if (!songs.length) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center" style={{ color: "var(--ink-3)" }}>
        <Mic2 size={28} aria-hidden />
        <p className="m-0 font-semibold">{t("No songs by {{artist}} in the library.", { artist: name })}</p>
      </div>
    );
  }

  //  playing
  const decorate = (tr) => {
    const { albumName, fileName } = parseTrackPath(tr.path);
    const album = tr.album && typeof tr.album === "object" ? tr.album : null;
    return { ...tr, album: albumStub(album, album ? album.cover || buildAlbumCoverUrl(album) : null), url_path: buildMediaUrl(albumName, fileName) };
  };
  const playFrom = (list, start = 0) => {
    const decorated = list.map(decorate);
    if (!decorated.length) return;
    play(decorated[start], { replaceQueue: true, upcomingTracks: decorated.slice(start + 1), context: decorated });
  };
  const playSongs = (list) => playFrom(list, 0);
  const onRowPlay = (track) => {
    const i = songs.findIndex((x) => x.path === track.path);
    playFrom(songs, Math.max(0, i));
  };
  const albumSongs = (album: { tracks?: any[] }) => [...(album.tracks || [])].sort(byTrackNumber).map((tr) => ({ ...tr, album }));
  const playingAlbumId = selectedTrack ? albumDirOf(selectedTrack) || null : null;

  //  menus
  const openCtx = (track, e) => {
    e.preventDefault();
    const list = selection.forRow(songs.find((x) => x.path === track.path) || track);
    setCtx({ open: true, ...menuPointFrom(e), track, songs: list, album: null });
    playlistMenu.refresh();
  };
  const openAlbumCtx = (album: Album, e: React.MouseEvent) => {
    e.preventDefault();
    setCtx({ open: true, ...menuPointFrom(e), track: null, songs: albumSongs(album), album });
    playlistMenu.refresh();
  };
  const ctxItems = ctx.album || ctx.track ? songMenu.build({
    selection: !!ctx.album,
    omit: new Set(["goToArtist"]),
    onPlay: () => ctx.album || ctxSongs.length > 1 ? playSongs(ctxSongs) : onRowPlay(ctx.track),
    onPlayNext: () => addNextInQueue(ctxSongs.map(decorate)),
    onQueue: () => addToQueue(ctxSongs.map(decorate)),
    playlistSubmenu: playlistMenu.submenu(ctxSongs),
    onOpenAlbum: ctx.album ? () => openLibraryAlbum(ctx.album) : ctxSongs.length === 1 ? () => openLibraryAlbum(ctx.track) : undefined,
    onOpenLyrics: !ctx.album && ctxSongs.length === 1 ? () => setLyricsTrack(ctx.track) : undefined,
  }) : [];

  //  "See in the catalog"
  const openInCatalog = async () => {
    if (finding) return;
    setFinding(true);
    try {
      const res: any = await searchCatalog(displayName, { types: ["artists"], limit: 10 } as any);
      const found = Array.isArray(res?.artists) ? res.artists : [];
      const pick = found.find((a) => artistKey(a.name) === key) || found[0];
      if (!pick?.ref?.id) {
        showError(t("Couldn't find {{artist}} in the catalog.", { artist: displayName }));
        return;
      }
      push({ kind: "artist", provider: pick.ref.provider, id: String(pick.ref.id), title: pick.name || displayName });
    } catch (e) {
      showError((e as Error)?.message || t("Couldn't search the catalog."));
    } finally {
      setFinding(false);
    }
  };

  const total = songs.reduce((s, tr) => s + (Number(tr.duration) || 0), 0);
  const albumCount = own.length + appearsOn.length;
  const facts = [
    t("{{n}} albums", { count: albumCount, n: albumCount }),
    t("{{n}} songs", { count: songs.length, n: songs.length }),
    formatTotal(total, t),
  ].filter(Boolean);

  const grid = (list: Album[]) => (
    <AlbumGrid
      albums={list}
      albumIdOf={(a) => String(a.path)}
      playingAlbumId={playingAlbumId}
      isPlaying={isPlaying}
      onOpen={(a) => openLibraryAlbum(albums.find((x) => x.path === a.path) || a)}
      onPlay={(a) => playSongs(albumSongs(a))}
      onTogglePlay={() => setIsPlaying(!isPlaying)}
      onContextMenu={openAlbumCtx}
    />
  );

  return (
    <div
      ref={pageRef}
      tabIndex={-1}
      className="flex flex-col outline-none"
      onKeyDown={(e) => {
        const reveal = selection.onKeyDown(e);
        if (reveal) pageRef.current?.querySelector(`[data-path="${CSS.escape(reveal)}"]`)?.scrollIntoView({ block: "nearest" });
      }}
      onMouseDown={(e) => {
        const target = e.target as Element;
        if (!target.closest?.(".retro-song-table__row, button, input, a, [role='menu']")) selection.clear();
        if (!target.closest?.("input, textarea")) pageRef.current?.focus({ preventScroll: true });
      }}
    >
      <div className="playlist-hero" style={{ "--list-color": color, "--list-ink": ink } as React.CSSProperties}>
        <header className="playlist-band">
          <div className="playlist-band__cover" style={{ width: HERO_COVER, height: HERO_COVER, borderRadius: "50%", overflow: "hidden" }}>
            <CoverTile src={cover} label={displayName} fontSize="56px" className="w-full h-full" />
          </div>
          <div className="flex flex-col gap-2 min-w-0 flex-1">
            <span className="text-[12px] font-bold uppercase tracking-wide opacity-80">{t("Artist")}</span>
            <h1 className="playlist-band__title">{displayName}</h1>
            <div className="flex items-center gap-2 flex-wrap text-[13px]">
              <span className="opacity-85">{facts.join(" · ")}</span>
            </div>
            {/* Inside the text column, as on a playlist: the row takes the
                header's padding instead of starting at the window's edge. */}
            <div className="playlist-actions">
              <button
                type="button"
                className="playlist-actions__play"
                onClick={() => playFrom(songs, 0)}
                title={t("Play")}
                aria-label={t("Play")}
              >
                <Play size={18} strokeWidth={0} fill="currentColor" aria-hidden />
              </button>
              <button
                type="button"
                className={`playlist-actions__icon ${shuffleEnabled ? "is-on" : ""}`}
                onClick={toggleShuffle}
                aria-pressed={shuffleEnabled}
                title={shuffleEnabled ? t("Turn shuffle off") : t("Turn shuffle on")}
                aria-label={t("Shuffle")}
              >
                <Shuffle size={18} strokeWidth={2.25} />
              </button>
              <RemovalMenu items={headerRemovals} className="playlist-actions__icon" />
              <button
                type="button"
                className="library-icon-btn library-icon-btn--text ml-1"
                onClick={openInCatalog}
                disabled={finding}
                aria-busy={finding}
                title={t("See everything by {{artist}} in the catalog, including what you don't have", { artist: displayName })}
              >
                {finding ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Telescope size={14} aria-hidden />}
                <span>{t("See in the catalog")}</span>
              </button>
            </div>
          </div>
        </header>
      </div>

      {own.length > 0 && (
        <section className="flex flex-col gap-2 mb-4">
          <h2 className="m-0 text-[13px] font-bold uppercase tracking-wide" style={{ color: "var(--ink-3)" }}>{t("Albums")}</h2>
          <div className="bg-panel border-2 border-black rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] overflow-clip">{grid(own)}</div>
        </section>
      )}
      {appearsOn.length > 0 && (
        <section className="flex flex-col gap-2 mb-4">
          <h2 className="m-0 text-[13px] font-bold uppercase tracking-wide" style={{ color: "var(--ink-3)" }}>{t("Appears on")}</h2>
          <div className="bg-panel border-2 border-black rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] overflow-clip">{grid(appearsOn)}</div>
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-[13px] font-bold uppercase tracking-wide" style={{ color: "var(--ink-3)" }}>{t("Songs")}</h2>
        <div className="bg-panel border-2 border-black rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] overflow-clip">
          <EmptySongColumnsContext.Provider value={emptyColumns}>
          <div className={`retro-song-table retro-song-table--embedded ${songTableRootClass(columns, false, "library", emptyColumns)}`} style={{ "--song-table-head": color, "--song-table-head-ink": ink } as React.CSSProperties}>
            <SongTableHeader />
            <ul className="retro-song-table__body text-sm">
              {songs.map((track, i) => (
                <AlbumTrackRow
                  key={track.path}
                  showCovers={columns.covers.library}
                  track={track}
                  album={track.album}
                  index={i}
                  number={i + 1}
                  selected={selection.isSelected(track)}
                  isActive={selectedTrack?.path === track.path}
                  onSelect={selection.click}
                  onPlay={onRowPlay}
                  onOpenAlbum={(tr) => openLibraryAlbum(tr.album)}
                  onOpenArtist={(other) => artistKey(other) !== key && openLibraryArtist(other)}
                  onContextMenu={openCtx}
                  onOpenAnalysis={(tr) => { setInfoOpened(true); openTrackInfo(tr); }}
                />
              ))}
            </ul>
          </div>
          </EmptySongColumnsContext.Provider>
        </div>
      </section>

      <SelectionBar
        tracks={selection.selected}
        count={selection.count}
        onPlay={() => playSongs(selection.selected)}
        onPlayNext={() => addNextInQueue(selection.selected.map(decorate))}
        onQueue={() => addToQueue(selection.selected.map(decorate))}
        playlistItems={playlistMenu.submenu(selection.selected)}
        onClear={selection.clear}
      />

      <TrackContextMenu
        open={ctx.open}
        x={ctx.x}
        y={ctx.y}
        title={ctx.album ? ctx.album.album : ctxSongs.length > 1 ? t("{{n}} songs", { count: ctxSongs.length, n: ctxSongs.length }) : ctx.track?.title}
        artist={ctx.album ? ctx.album.artist || "" : ctxSongs.length > 1 ? "" : ctx.track?.artist || ""}
        items={ctxItems}
        onClose={() => setCtx((c) => ({ ...c, open: false }))}
      />
      <LyricsModal open={!!lyricsTrack} relPath={lyricsKeyOf(lyricsTrack)} track={lyricsTrack} onClose={() => setLyricsTrack(null)} />
      {infoOpened && <TrackInfoHost />}
    </div>
  );
}
