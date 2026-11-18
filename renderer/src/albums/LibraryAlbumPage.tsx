import { useSongMenu } from "../library/tracks/useSongMenu";
import SongTableHeader from "../library/tracks/SongTableHeader";
import { EmptySongColumnsContext, songTableGridStyle, songTableRootClass, useEmptySongColumns, useSongTableColumns } from "../library/tracks/songTableColumns";
import CollectionActions from "../acquisition/CollectionActions";
import { RowEnd } from "../acquisition/RowState";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { genreLabel } from "./genreLabel";
import type { TFunction } from "i18next";
import { ArrowRightLeft, Disc3, FolderInput, Loader2, Play, Plus, Shuffle, MoreHorizontal } from "lucide-react";
import { useCurrentUser } from "../data";
import { openMatch } from "../match/matchStore";
import { useAudioPlayer } from "@state/AudioPlayerContext";
import { albumStub } from "@lib/albumStub";
import { relPathOf } from "@state/userLibraryStore";
import { albumDirName, buildAlbumCoverUrl, buildMediaUrl, parseTrackPath } from "@lib/api";
import { useStatus } from "../state/useStatus";
import { checkOwnership, fetchAlbum, search as searchCatalog } from "../browse/browseApi";
import { openLibraryAlbum, openLibraryArtist } from "../browse/navigationStore";
import { masDe, primaryArtist } from "./artistMatch";
import { useAcquisition } from "../browse/useAcquisition";
import { AcquireBar } from "../browse/AcquireBar";
import { announceLibraryChanged, confirmReplace, foldTitle, moveTrack, replacementLanded } from "../browse/resolve";
import { formatDuration } from "@lib/formatting";
import CoverTile from "../ui/components/CoverTile";
import CoverCard from "../ui/components/CoverCard";
import SectionFoldButton from "../ui/components/SectionFoldButton";
import { artColorFor } from "../ui/components/cardArt";
import { playlistInk } from "../playlists/playlistBadge";
import SelectionBar from "../ui/components/SelectionBar";
import { useSongSelection } from "../library/tracks/useSongSelection";
import { useAddToPlaylistMenu } from "../library/tracks/useAddToPlaylistMenu";
import AlbumTrackRowUntyped from "./AlbumTrackRow";
import { TrackInfoHost } from "../library/tracks/TrackInfoModal";
import { openTrackInfo } from "../library/tracks/trackInfoStore";
import TrackContextMenu, { menuPointFrom } from "./TrackContextMenu";
import LyricsModal from "../lyrics/LyricsModal";
import { lyricsKeyOf } from "../lyrics/lyricsStore";

/** The album directory identifies this browse route so Back returns to its opener.
 * Full-album rows use server ownership and shared resolve verbs to avoid duplicate acquisitions. */
// The legacy modules below are untyped JavaScript; these are the seams.
const AlbumTrackRow = AlbumTrackRowUntyped as unknown as React.ComponentType<any>;
type Album = { path: string; album?: string; artist?: string; year?: string | number; genre?: string | string[]; cover?: string; tracks?: any[] };

function formatTotal(seconds: number, t: TFunction) {
  const total = Math.round(Number(seconds) || 0);
  if (!total) return null;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h ? t("{{h}} h {{m}} min", { h, m }) : t("{{m}} min", { m });
}

// "More from" folds, and stays folded across albums and launches.
const MAS_DE_KEY = "krobi.album.masDeOpen";
function readMasDeOpen() {
  try {
    return localStorage.getItem(MAS_DE_KEY) !== "false";
  } catch {
    return true;
  }
}
function writeMasDeOpen(open: boolean) {
  try {
    localStorage.setItem(MAS_DE_KEY, String(open));
  } catch {
    // A per-viewer convenience: without storage it just opens next time.
  }
}

/** The playlist hero's cover size (PlaylistHero COVER): it follows the window. */
const HERO_COVER = "clamp(140px, 18vw, 220px)";

export default function LibraryAlbumPage({ id, albums = [], online = true }: { id: string; albums?: Album[]; online?: boolean }) {
  const { t, i18n } = useTranslation();
  const me = useCurrentUser();
  const [albumMenu, setAlbumMenu] = useState<{ x: number; y: number } | null>(null);
  const [masDeOpen, setMasDeOpen] = useState(readMasDeOpen);
  const [infoOpened, setInfoOpened] = useState(false);
  const { play, addToQueue, addNextInQueue, selectedTrack, shuffleEnabled, toggleShuffle } = useAudioPlayer() as any;
  const { showSuccess, showError } = useStatus() as any;
  const [lyricsTrack, setLyricsTrack] = useState<any>(null);
  const [ctx, setCtx] = useState<{ open: boolean; x: number; y: number; track: any; songs: any[] }>({ open: false, x: 0, y: 0, track: null, songs: [] });
  // The catalog's tracklist, once asked for: off → loading → ready.
  const [full, setFull] = useState<{ status: "off" | "loading" | "ready"; catalog?: any[]; verdicts?: any[] }>({ status: "off" });
  const recheck = async (catalog: any[]) => {
    const verdicts = await checkOwnership(catalog);
    setFull({ status: "ready", catalog, verdicts });
  };
  const acquisition = useAcquisition((snapshot, asked) => {
    // The files landed: re-read the album list (new rows) and the verdicts.
    // A replacement has already announced itself (`useAcquisition`).
    if (!replacementLanded(snapshot, asked)) announceLibraryChanged();
    if (full.catalog) void recheck(full.catalog);
  });
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [moving, setMoving] = useState<Set<string>>(() => new Set());
  const pageRef = useRef<HTMLDivElement>(null);

  const album = useMemo(() => albums.find((a) => String(a.path) === String(id)) || null, [albums, id]);
  const moreAlbums = useMemo(() => (album ? masDe(album, albums) : []), [album, albums]);
  // A re-read album list is what lands a moved song as a row of its own.
  useEffect(() => setMoving(new Set()), [album]);
  const cover = album ? album.cover || buildAlbumCoverUrl(album) : null;
  const tracks = useMemo(
    () =>
      [...(album?.tracks || [])]
        .sort((a, b) => (Number(a.track_number) || Infinity) - (Number(b.track_number) || Infinity))
        .map((tr) => ({ ...tr, album })),
    [album],
  );

  const columns = useSongTableColumns();
  const emptyColumns = useEmptySongColumns(tracks);

  // Keep server-owned rows in catalog order and append library tracks absent from the catalog.
  const rows = useMemo<any[]>(() => {
    if (full.status !== "ready") return tracks.map((tr) => ({ kind: "own", track: tr }));
    const byPath = new Map(tracks.map((tr) => [String(tr.path), tr]));
    const used = new Set();
    const merged = (full.catalog || []).map((ct, i) => {
      const v = full.verdicts?.[i];
      const local = v?.owned && v.match ? byPath.get(String(v.match.path)) : null;
      if (local && !used.has(local.path)) {
        used.add(local.path);
        return { kind: "own", track: local };
      }
      // Owned, but the file is in another album's folder: "Move here".
      const elsewhere = v?.owned && v.match && !byPath.has(String(v.match.path)) ? v.match : null;
      return { kind: "missing", ct, near: v?.nearMatch || null, elsewhere };
    });
    return [...merged, ...tracks.filter((tr) => !used.has(tr.path)).map((tr) => ({ kind: "own", track: tr }))];
  }, [tracks, full]);
  const ownShown = useMemo(() => rows.filter((r) => r.kind === "own").map((r) => r.track), [rows]);
  const missing = useMemo(() => rows.filter((r) => r.kind === "missing").map((r) => r.ct), [rows]);
  // What "Add" downloads: not the songs to move here.
  const selection = useSongSelection(ownShown);
  const ctxSongs = ctx.songs || [];
  const songMenu = useSongMenu(ctxSongs, { showSuccess, showError, onChanged: selection.clear });
  const albumSongMenu = useSongMenu(tracks, { showSuccess, showError });
  const playlistMenu = useAddToPlaylistMenu({ showSuccess, showError });

  if (!album) {
    return (
      <div className="flex flex-col items-center gap-2 py-16 text-center" style={{ color: "var(--ink-3)" }}>
        <Disc3 size={28} aria-hidden />
        <p className="m-0 font-semibold">{t("This album is no longer in the library.")}</p>
      </div>
    );
  }

  const name = album.album || t("Album");
  const color = artColorFor(name);
  const ink = playlistInk(name);

  //  playing
  const decorate = (tr) => {
    const { albumName, fileName } = parseTrackPath(tr.path);
    return { ...tr, album: albumStub(album, cover), url_path: buildMediaUrl(albumName, fileName) };
  };
  const playFrom = (list, start = 0) => {
    const startPath = list[start]?.path;
    const decorated = list.filter(tr => !tr.missingFromNest).map(decorate);
    start = Math.max(0, decorated.findIndex(tr => tr.path === startPath));
    if (!decorated.length) return;
    play(decorated[start], { replaceQueue: true, upcomingTracks: decorated.slice(start + 1), context: decorated });
  };
  const playSongs = (songs) => playFrom(songs, 0);
  const onRowPlay = (track) => {
    if (track.missingFromNest) return;
    const i = ownShown.findIndex((x) => x.path === track.path);
    playFrom(ownShown, Math.max(0, i));
  };

  //  menus
  const openCtx = (track, e) => {
    e.preventDefault();
    const songs = selection.forRow(tracks.find((x) => x.path === track.path) || track);
    setCtx({ open: true, ...menuPointFrom(e), track, songs });
    playlistMenu.refresh();
  };
  const ctxItems = ctx.track ? songMenu.build({
    omit: new Set(["openAlbum"]),
    onPlay: () => ctxSongs.length > 1 ? playSongs(ctxSongs) : onRowPlay(ctx.track),
    onPlayNext: () => addNextInQueue(ctxSongs.map(decorate)),
    onQueue: () => addToQueue(ctxSongs.map(decorate)),
    playlistSubmenu: playlistMenu.submenu(ctxSongs),
    onOpenLyrics: ctxSongs.length === 1 ? () => setLyricsTrack(ctx.track) : undefined,
  }) : [];
  const albumItems = albumSongMenu.build({
    selection: true,
    omit: new Set(["openAlbum"]),
    onPlay: () => playSongs(tracks),
    onPlayNext: () => addNextInQueue(tracks.map(decorate)),
    onQueue: () => addToQueue(tracks.map(decorate)),
    playlistSubmenu: playlistMenu.submenu(tracks),
    onGoToArtist: () => openLibraryArtist(primaryArtist(album.artist)),
    artistDisabled: !album.artist,
    onOpenLyrics: undefined,
    onMatch: me.data?.isOwner ? () => openMatch({ albumKey: albumDirName(album), title: name }) : undefined,
  });

  //  "Show full album"
  const showFullAlbum = async () => {
    if (full.status === "ready") {
      setFull({ status: "off" });
      return;
    }
    if (full.status === "loading") return;
    setFull({ status: "loading" });
    try {
      const res: any = await searchCatalog(`${album.artist || ""} ${name}`.trim(), { types: ["albums"], limit: 10 } as any);
      const found = Array.isArray(res?.albums) ? res.albums : [];
      const wantTitle = foldTitle(name);
      const wantArtist = foldTitle(album.artist);
      const sameArtist = (a) => !wantArtist || foldTitle(a.artistName) === wantArtist;
      const pick =
        found.find((a) => foldTitle(a.title) === wantTitle && sameArtist(a)) ||
        found.find((a) => foldTitle(a.title) === wantTitle) ||
        found.find((a) => sameArtist(a) && foldTitle(a.title).includes(wantTitle));
      if (!pick?.ref?.id) {
        setFull({ status: "off" });
        showError(t("Couldn't find “{{album}}” in the catalog.", { album: name }));
        return;
      }
      const data: any = await fetchAlbum(pick.ref.provider, pick.ref.id, {});
      await recheck(Array.isArray(data?.tracks) ? data.tracks : []);
    } catch (e) {
      setFull({ status: "off" });
      showError((e as Error)?.message || t("Couldn't search the catalog."));
    }
  };
  const keyOf = (ct) => `${ct.trackPosition ?? ""}:${ct.title}`;
  const getSongs = (cts: any[]) => {
    setPending((prev) => new Set([...prev, ...cts.map(keyOf)]));
    void acquisition.acquire(cts, undefined);
  };
  const moveHere = async (row) => {
    const key = keyOf(row.ct);
    if (moving.has(key)) return;
    setMoving((prev) => new Set(prev).add(key));
    try {
      await moveTrack({ path: row.elsewhere.path, albumDir: albumDirName(album), albumTitle: name, trackNumber: row.ct.trackPosition ?? null });
      showSuccess(t("“{{title}}” moved to “{{album}}”", { title: row.ct.title, album: name }));
      announceLibraryChanged();
      if (full.catalog) await recheck(full.catalog);
      // Keep the spinner until the refreshed listing reflects the move, preventing a duplicate action.
    } catch (e) {
      showError((e as Error)?.message || t("Couldn't move it."));
      setMoving((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };
  const replaceWith = async (row) => {
    if (await confirmReplace(row.near)) getSongs([{ ...row.ct, replaces: row.near.path }]);
  };

  const total = tracks.reduce((s, tr) => s + (Number(tr.duration) || 0), 0);
  const facts = [
    album.year ? String(album.year) : null,
    full.status === "ready" && missing.length
      ? t("{{owned}} of {{total}} songs", { owned: ownShown.length, total: rows.length })
      : t("{{n}} songs", { count: tracks.length, n: tracks.length }),
    formatTotal(total, t),
    genreLabel(album.genre, i18n.resolvedLanguage || i18n.language) || null,
  ].filter(Boolean);

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
          <div className="playlist-band__cover" style={{ width: HERO_COVER, height: HERO_COVER }}>
            <CoverTile src={cover} label={name} fontSize="56px" className="w-full h-full" />
          </div>
          <div className="flex flex-col gap-2 min-w-0 flex-1">
            <span className="text-[12px] font-bold uppercase tracking-wide opacity-80">{t("Album")}</span>
            <h1 className="playlist-band__title">{name}</h1>
            <div className="flex items-center gap-2 flex-wrap text-[13px]">
              {album.artist ? (
                <button
                  type="button"
                  className="playlist-band__owner playlist-band__owner--link"
                  onClick={() => openLibraryArtist(primaryArtist(album.artist))}
                  title={t("Go to artist")}
                >
                  {album.artist}
                </button>
              ) : null}
              <span className="opacity-85">{facts.join(" · ")}</span>
            </div>
            {/* Inside the text column, as on a playlist: the row takes the
                header's padding instead of starting at the window's edge. */}
            <div className="playlist-actions">
              <button type="button" className="playlist-actions__icon" aria-label={t("Album options")} onClick={event => { setAlbumMenu(menuPointFrom(event)); playlistMenu.refresh(); }}><MoreHorizontal size={18} aria-hidden /></button>
              <button
                type="button"
                className="playlist-actions__play"
                onClick={() => playFrom(tracks, 0)}
                disabled={!tracks.length}
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
              <CollectionActions kind="album" refId={id} title={name} tracks={full.status === 'ready' ? rows.map(r => r.kind === 'own' ? { title: r.track.title } : r.ct) : tracks} catalog={full.status === 'ready'} verdicts={full.status === 'ready' ? rows.map(r => r.kind === 'own' ? { owned: true, match: r.track } : r.elsewhere ? { owned: true, match: r.elsewhere } : {}) : undefined} acquisition={acquisition} />
              <AcquireBar acquisition={acquisition} inline />
            </div>
          </div>
        </header>
      </div>

      <div className="bg-panel border-2 border-black rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] overflow-clip">
        <EmptySongColumnsContext.Provider value={emptyColumns}>
        <div className={`retro-song-table retro-song-table--embedded ${songTableRootClass(columns, false, "library", emptyColumns)}`} style={{ "--song-table-head": color, "--song-table-head-ink": ink } as React.CSSProperties}>
          <SongTableHeader />
          <ul className="retro-song-table__body text-sm">
            {rows.map((row, i) =>
              row.kind === "own" ? (
                <AlbumTrackRow
                  key={row.track.path}
                  showCovers={columns.covers.library}
                  track={row.track}
                  album={album}
                  index={i}
                  number={row.track.track_number ?? i + 1}
                  selected={selection.isSelected(row.track)}
                  isActive={selectedTrack?.path === row.track.path}
                  onSelect={selection.click}
                  onPlay={onRowPlay}
                  onOpenArtist={openLibraryArtist}
                  onContextMenu={openCtx}
                  onOpenAnalysis={(tr) => { setInfoOpened(true); openTrackInfo(tr); }}
                />
              ) : (
                <li style={songTableGridStyle(columns.order)} key={`missing-${keyOf(row.ct)}-${i}`} onContextMenu={row.elsewhere ? event => openCtx(row.elsewhere, event) : undefined} className="retro-song-table__row song-grid song-row--missing flex items-center gap-3 px-3 py-1.5">
                  <div className="song-col--num w-8 shrink-0 text-center tabular-nums">{String(row.ct.trackPosition ?? i + 1).padStart(2, "0")}</div>
                  <div className="song-col--cover" aria-hidden />
                  <div className="song-col--title flex-1 truncate" title={row.near ? t("You have another version: {{title}}", { title: row.near.title }) : undefined}>
                    {row.ct.title}
                    {row.elsewhere ? (
                      <span className="song-row--missing__note">{t("in “{{album}}”", { album: row.elsewhere.album || t("another album") })}</span>
                    ) : null}
                  </div>
                  <div className="song-col--artist truncate">{row.ct.artistName || album.artist || ""}</div>
                  <div className="song-col--album" />
                  <div className="song-col--genre" />
                  <div className="song-col--date w-24" />
                  <div className="song-col--analysis w-14" />
                  <div className="song-col--key" />
                  <div className="song-col--bpm w-16" />
                  <div className="song-col--lyrics" />
                  <div className="song-col--duration text-right tabular-nums">{row.ct.durationSeconds ? formatDuration(row.ct.durationSeconds) : ""}</div>
                  <RowEnd title={row.ct.title} catalog inNest={!!row.elsewhere} trackKey={row.elsewhere ? relPathOf(row.elsewhere) : undefined} near={!!row.near} nearDuration={row.near?.durationSeconds} busy={pending.has(keyOf(row.ct)) && acquisition.active} item={acquisition.request?.items?.filter(item => item.item === row.ct.title).at(-1)} onAdd={() => getSongs([row.ct])} onRetry={() => getSongs([row.ct])}>
                    {row.elsewhere ? (
                      <button
                        type="button"
                        className="song-row__action acquire-square"
                        onClick={() => moveHere(row)}
                        disabled={moving.has(keyOf(row.ct))}
                        aria-busy={moving.has(keyOf(row.ct)) || undefined}
                        title={t("Move here")}
                        aria-label={t("Move “{{title}}” here", { title: row.ct.title })}
                      >
                        {moving.has(keyOf(row.ct)) ? (
                          <Loader2 size={13} className="animate-spin" aria-hidden />
                        ) : (
                          <FolderInput size={13} strokeWidth={2.5} aria-hidden />
                        )}
                      </button>
                    ) : row.near ? (
                      <button
                        type="button"
                        className="song-row__action acquire-square"
                        onClick={() => replaceWith(row)}
                        disabled={pending.has(keyOf(row.ct)) && acquisition.active}
                        title={t("Swap for this version")}
                        aria-label={t("Swap “{{title}}” for this version", { title: row.ct.title })}
                      >
                        {pending.has(keyOf(row.ct)) && acquisition.active ? (
                          <Loader2 size={13} className="animate-spin" aria-hidden />
                        ) : (
                          <ArrowRightLeft size={13} strokeWidth={2.5} aria-hidden />
                        )}
                      </button>
                    ) : null}
                  </RowEnd>
                </li>
              ),
            )}
          </ul>
        </div>
        </EmptySongColumnsContext.Provider>
      </div>

      {online && (
        <div className="album-after">
          <button
            type="button"
            className={`album-after__btn ${full.status === "ready" ? "is-on" : ""}`}
            onClick={showFullAlbum}
            disabled={full.status === "loading"}
            aria-busy={full.status === "loading"}
            aria-pressed={full.status === "ready"}
            title={t("See every song on the album, including the ones you don't have")}
          >
            {full.status === "loading" ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Disc3 size={15} aria-hidden />}
            <span>{full.status === "ready" ? t("Only the ones I have") : t("Show full album")}</span>
          </button>

        </div>
      )}

      {moreAlbums.length > 0 && (
        <section className="album-more">
          <SectionFoldButton
            title={t("More by {{artist}}", { artist: primaryArtist(album.artist) })}
            count={moreAlbums.length}
            open={masDeOpen}
            onToggle={() => {
              writeMasDeOpen(!masDeOpen);
              setMasDeOpen(!masDeOpen);
            }}
          />
          {masDeOpen && (
            <ul className="album-more__grid">
              {moreAlbums.map((a) => {
                const other = a.album || t("Album");
                return (
                  <li key={a.path}>
                    <CoverCard
                      cover={<CoverTile src={a.cover || buildAlbumCoverUrl(a)} label={other} fontSize="34px" />}
                      title={other}
                      openLabel={t("Open {{album}}", { album: other })}
                      subtitle={a.year ? String(a.year) : undefined}
                      onOpen={() => openLibraryAlbum(a)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

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
        title={ctxSongs.length > 1 ? t("{{n}} songs", { count: ctxSongs.length, n: ctxSongs.length }) : ctx.track?.title}
        artist={ctxSongs.length > 1 ? "" : ctx.track?.artist || album.artist || ""}
        items={ctxItems}
        onClose={() => setCtx((c) => ({ ...c, open: false }))}
      />
      <TrackContextMenu open={!!albumMenu} x={albumMenu?.x || 0} y={albumMenu?.y || 0} title={name}
        items={albumItems}
        onClose={() => setAlbumMenu(null)} />
      <LyricsModal open={!!lyricsTrack} relPath={lyricsKeyOf(lyricsTrack)} track={lyricsTrack} onClose={() => setLyricsTrack(null)} />
      {infoOpened && <TrackInfoHost />}
    </div>
  );
}
