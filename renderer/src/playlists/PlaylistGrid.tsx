import { ContentPlaceholder } from "../ui/components/ContentPlaceholder";
import { ListMusic, Plus } from "lucide-react";
import { useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type Ref, type RefObject } from "react";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { albumDirName, apiUrl, buildAlbumThumbUrl, buildCoverImageUrl, parseTrackPath } from "@lib/api";
import CoverTile, { CoverMosaic } from "../ui/components/CoverTile";
import CoverCard from "../ui/components/CoverCard";
import { playlistColor, playlistCount, playlistCover, playlistCoverAlbums, playlistInitials } from "./playlistBadge";
import { Missing } from "../ui/react/components/Missing";
import type { SongRowsHandle } from "../albums/SongRows";
import { toRow, type LibraryAlbum, type PlaylistTrack } from "./playlistTracks";
import "./playlist-grid.css";

/** Show a playlist grid when no list is selected so navigation remains available
 * when the sidebar is hidden in portrait. */
interface PlaylistGridProps {
  playlists: unknown[];
  loaded?: boolean;
  onOpen: (name: string) => void;
  /** Called with the new playlist's name once the backend has created it. */
  onCreated?: (name: string) => void;
}

const TILE_CLASS =
  "playlist-grid-card flex flex-col gap-2 rounded-xl border-2 border-black p-2.5 text-left shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] transition-transform hover:-translate-x-px hover:-translate-y-px hover:shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] focus:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-inset";
// Inline so it beats the unlayered global `button {}` rule (coral bg, 36 px
// min-height); same reason PortraitTabBar does it.
const TILE_STYLE = { minHeight: 0, background: "var(--panel)", cursor: "pointer" } as const;

function NewPlaylistTile({ onCreated }: { onCreated?: (name: string) => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const close = () => { setEditing(false); setName(""); setError(null); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      // Same request the sidebar's form sends; the sidebar and the Home panel
      // refresh off the `playlists-changed` event, so one create updates all three.
      const res = await fetch(apiUrl("/api/playlists"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed, description: "" }),
      });
      if (!res.ok) {
        // 409: the name is taken, whoever owns it; names are one household namespace.
        setError(res.status === 409 ? t("A playlist with that name already exists.") : t("Couldn't create (HTTP {{status}}).", { status: res.status }));
        return;
      }
      window.dispatchEvent(new CustomEvent("playlists-changed"));
      close();
      onCreated?.(trimmed);
    } catch {
      setError(t("The playlist couldn't be created."));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title={t("New playlist")}
        className={TILE_CLASS}
        style={TILE_STYLE}
      >
        <span
          aria-hidden
          className="grid w-full place-items-center rounded-panel border-2 border-dashed border-black/60 text-black/70"
          style={{ aspectRatio: "1", background: "var(--paper-2)" }}
        >
          <Plus size={36} strokeWidth={2.5} />
        </span>
        <span className="block truncate text-sm font-bold text-black">{t("New playlist")}</span>
      </button>
    );
  }

  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-2 rounded-xl border-2 border-black p-2.5 shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]"
      style={{ background: "var(--panel)" }}
    >
      <span
        aria-hidden
        className="grid w-full place-items-center rounded-panel border-2 border-black text-black/85"
        style={{
          aspectRatio: "1",
          background: name.trim() ? playlistColor(name.trim()) : "var(--paper-2)",
          fontFamily: "var(--font-display)",
          fontSize: "clamp(28px, 4vw, 44px)",
          fontWeight: 800,
        }}
      >
        {name.trim() ? playlistInitials(name.trim()) : <Plus size={36} strokeWidth={2.5} />}
      </span>
      <input
        ref={inputRef}
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Escape") close(); }}
        placeholder={t("Name")}
        disabled={busy}
        aria-label={t("Playlist name")}
        className="w-full min-w-0 rounded border-2 border-black bg-white px-2 py-1 text-sm font-semibold text-black focus:outline-none"
      />
      {error && <span className="text-[11px] leading-tight text-[var(--rose)]">{error}</span>}
      <span className="flex gap-1.5">
        <button
          type="submit"
          disabled={!name.trim() || busy}
          className="flex-1 rounded border-2 border-black px-2 py-1 text-xs font-bold text-white disabled:opacity-50"
          style={{ minHeight: 0, background: "var(--dm-night, var(--ink))", cursor: "pointer" }}
        >
          {t("Create")}
        </button>
        <button
          type="button"
          onClick={close}
          disabled={busy}
          className="rounded border-2 border-black px-2 py-1 text-xs font-bold text-black"
          style={{ minHeight: 0, background: "var(--panel)", cursor: "pointer" }}
        >
          {t("Cancel")}
        </button>
      </span>
    </form>
  );
}

export default function PlaylistGrid({ playlists, loaded = true, onOpen, onCreated }: PlaylistGridProps) {
  const { t } = useTranslation();
  if (!loaded) return <ContentPlaceholder />;
  return (
    // The panel around it (PlaylistView's "Your playlists") pads it and the page
    // scrolls it, so the grid adds neither.
    <div>
      <div className="grid gap-x-4 gap-y-5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
        <NewPlaylistTile onCreated={onCreated} />
        {playlists.map((p, i) => {
          const raw = p && typeof p === "object" ? (p as { name?: unknown }).name : p;
          const name = raw == null ? t("Playlist") : String(raw);
          const count = playlistCount(p);
          // Playlist-level artwork (a Spotify import's) wins; otherwise the
          // first albums' covers, by directory name; `coverAlbums` is the
          // media route's key, not the display name.
          const own = playlistCover(p);
          const covers = own ? [own] : playlistCoverAlbums(p).map((dir) => buildCoverImageUrl(dir)).filter(Boolean);
          return (
            <CoverCard
              key={`${name}-${i}`}
              cover={<CoverMosaic covers={covers} label={name} className="w-full h-full" />}
              title={name}
              openLabel={t("Open the playlist {{name}}", { name })}
              subtitle={count != null ? t("{{n}} songs", { count, n: count }) : undefined}
              onOpen={() => onOpen(name)}
            />
          );
        })}
      </div>
      {playlists.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-10 text-[var(--ink-3)]">
          <ListMusic size={28} strokeWidth={2} aria-hidden />
          <p className="text-sm">{t("No playlists yet.")}</p>
        </div>
      )}
    </div>
  );
}

// The default export above is the playlists index. This leaf is the songs of
// one playlist; keeping the virtualizer here keeps scroll renders off its tools.
type SongGridProps = {
  tracks: PlaylistTrack[];
  albums?: LibraryAlbum[];
  scrollRef: RefObject<HTMLElement | null>;
  rowsRef?: Ref<SongRowsHandle>;
  initialOffset: number;
  scrollPaddingStart: number;
  activePath: string | null;
  isPlaying: boolean;
  menuPath?: string | null;
  selectionMode?: boolean;
  isSelected: (track: PlaylistTrack) => boolean;
  onSelect: (track: PlaylistTrack, event: MouseEvent) => void;
  onPlay: (track: PlaylistTrack) => void;
  onTogglePlay?: () => void;
  onContextMenu: (track: PlaylistTrack, event: MouseEvent) => void;
};

const MIN_TRACK = 140;
const TRACK_GAP_X = 14;
const TRACK_GAP_Y = 18;

export function PlaylistSongGrid({ tracks, albums = [], scrollRef, rowsRef, initialOffset, scrollPaddingStart, activePath, isPlaying, menuPath, selectionMode, isSelected, onSelect, onPlay, onTogglePlay, onContextMenu }: SongGridProps) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const firstCard = useRef<HTMLLIElement>(null);
  const [layout, setLayout] = useState({ columns: 1, height: 160, margin: 0 });
  const albumsByDir = useMemo(() => new Map(albums.map(album => [albumDirName(album), album])), [albums]);
  const albumsByPath = useMemo(() => new Map(albums.flatMap(album => (album.tracks ?? []).map(track => [track.path, album] as const))), [albums]);

  useLayoutEffect(() => {
    const grid = root.current;
    if (!grid) return;
    // A parent's ref attaches after its children's layout effects.
    let page = scrollRef.current ?? grid.parentElement;
    while (page?.parentElement && !/(auto|scroll)/.test(getComputedStyle(page).overflowY)) page = page.parentElement;
    if (!page) return;
    scrollRef.current ??= page;
    const measure = () => {
      const css = getComputedStyle(grid);
      const paddingTop = parseFloat(css.paddingTop) || 0;
      const width = grid.clientWidth - (parseFloat(css.paddingLeft) || 0) - (parseFloat(css.paddingRight) || 0);
      const columns = Math.max(1, Math.floor((width + TRACK_GAP_X) / (MIN_TRACK + TRACK_GAP_X)));
      const height = firstCard.current?.offsetHeight || Math.max(MIN_TRACK, (width - (columns - 1) * TRACK_GAP_X) / columns) + 40;
      const margin = grid.getBoundingClientRect().top + paddingTop - page.getBoundingClientRect().top - page.clientTop + page.scrollTop;
      setLayout(old => old.columns === columns && old.height === height && old.margin === margin
        ? old : { columns, height, margin });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    observer.observe(page);
    if (firstCard.current) observer.observe(firstCard.current);
    const band = page.querySelector(".playlist-band-anchor");
    if (band) observer.observe(band);
    return () => observer.disconnect();
  }, [scrollRef, tracks.length, scrollPaddingStart]);

  const virtual = tracks.length > 60;
  const rowCount = Math.ceil(tracks.length / layout.columns);
  const virtualizer = useVirtualizer({
    enabled: virtual,
    count: virtual ? rowCount : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => layout.height + TRACK_GAP_Y,
    scrollMargin: layout.margin,
    scrollPaddingStart,
    initialOffset,
    initialRect: { width: 0, height: typeof window === "undefined" ? 800 : window.innerHeight },
    overscan: 3,
    rangeExtractor: range => {
      const indexes = defaultRangeExtractor(range);
      return indexes.length && indexes[0] % 2 ? [indexes[0] - 1, ...indexes] : indexes;
    },
    useFlushSync: false,
  });
  useLayoutEffect(() => { virtualizer.measure(); }, [layout.height, layout.columns, virtualizer]);
  useImperativeHandle(rowsRef, () => ({
    scrollToIndex: index => {
      if (virtual) virtualizer.scrollToIndex(Math.floor(index / layout.columns), { align: "auto" });
      else root.current?.querySelectorAll<HTMLElement>("li[data-path]")[index]?.scrollIntoView({ block: "nearest" });
    },
  }), [virtual, virtualizer, layout.columns]);

  const rows = virtual ? virtualizer.getVirtualItems() : null;
  const from = rows?.length ? rows[0].index * layout.columns : 0;
  const to = rows?.length ? Math.min(tracks.length, (rows.at(-1)!.index + 1) * layout.columns) : virtual ? 0 : tracks.length;
  return (
    <div ref={root} className="playlist-track-grid" data-virtual={virtual || undefined}>
      <div className="playlist-track-grid__space" style={virtual ? { height: Math.max(0, virtualizer.getTotalSize() - TRACK_GAP_Y) } : undefined}>
        <ul className="playlist-track-grid__cards" data-first-index={from}
          style={virtual ? { position: "absolute", width: "100%", transform: `translateY(${rows?.length ? rows[0].start - layout.margin : 0}px)` } : undefined}>
          {tracks.slice(from, to).map((track, offset) => {
            const index = from + offset;
            const { albumName, artistName } = toRow(track);
            const dir = parseTrackPath(track.path).albumName;
            const album = albumsByPath.get(track.path) ?? albumsByDir.get(dir) ?? (typeof track.album === "object" ? track.album : null);
            const version = album && "coverVersion" in album ? album.coverVersion : undefined;
            const src = buildAlbumThumbUrl(album?.mediaKey || (album?.path ? albumDirName(album) : dir), version, 300);
            const title = track.title || t("Untitled");
            const current = activePath === track.path;
            return (
              <li key={virtual ? index % 256 : track.path} ref={offset === 0 ? firstCard : undefined}
                data-path={track.path} aria-current={current || undefined} aria-selected={isSelected(track)}
                className="playlist-track-grid__song"
                onClick={event => {
                  if (!(event.target as Element).closest("button")) onSelect(track, event);
                }}
                onDoubleClick={event => {
                  const button = (event.target as Element).closest("button");
                  if (!button || button.classList.contains("cover-card__open")) onPlay(track);
                }}
                onContextMenu={event => onContextMenu(track, event)}>
                <CoverCard
                  className="playlist-track-card"
                  cover={<CoverTile key={src} src={src} label={albumName || title} fontSize="24px" />}
                  title={title}
                  openLabel={t("Play {{song}}", { song: title })}
                  subtitle={<>{artistName ? <span title={artistName}>{artistName}</span> : <Missing kind="noArtist" />}</>}
                  onOpen={() => onPlay(track)}
                  onClickCapture={event => {
                    // Mouse clicks select just as in the list; double-click
                    // plays once. Keyboard activation of the primary button
                    // (detail=0) plays, as does its sibling disc.
                    if ((event.target as Element).closest(".cover-card__open") && (event.detail > 0 || selectionMode || event.metaKey || event.ctrlKey || event.shiftKey)) {
                      event.preventDefault();
                      event.stopPropagation();
                      onSelect(track, event);
                    }
                  }}
                  play={{ onPlay: () => onPlay(track), current, playing: isPlaying, onToggle: onTogglePlay, seed: albumName }}
                  onMenu={event => { event.stopPropagation(); onContextMenu(track, event); }}
                  menuButton={false}
                  menuOpen={menuPath === track.path}
                />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
