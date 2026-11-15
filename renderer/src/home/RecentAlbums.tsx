import { useSongMenu } from "../library/tracks/useSongMenu";
import type { LibraryAlbum, LibraryTrack } from "../albums/library.types";
import type { ListedTrack } from "./decorateTrack";
import type { PlayerTrack } from "@state/AudioPlayerContext";
import { SnapshotAge } from "../offline/SnapshotAge";
import { ContentPlaceholder } from "../ui/components/ContentPlaceholder";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ListMusic, RotateCcw } from "lucide-react";
import { useAudioPlayer } from "@state/AudioPlayerContext";
import { buildAlbumCoverUrl } from "@lib/api";
import CoverTile from "../ui/components/CoverTile";
import { decorate } from "./decorateTrack";
import CoverCard from "../ui/components/CoverCard";
import PanelHeader, { PANEL_ICON_BUTTON } from "../ui/components/PanelHeader";
import { useHeld } from "../ui/react/useHeld";
import RecentPickerModal from "./RecentPickerModal";
import TrackContextMenu, { menuPointFrom } from "../albums/TrackContextMenu";
import { useAddToPlaylistMenu } from "../library/tracks/useAddToPlaylistMenu";
import { openLibraryAlbum } from "../browse/navigationStore";
import LyricsModal from "../lyrics/LyricsModal";
import { lyricsKeyOf } from "../lyrics/lyricsStore";
import { useStatus } from "../state/useStatus";
import { motion } from "../ui/react/motion";
import { SONG_ACTION_COLOR } from "../library/tracks/songMenuItems";

// Key cover requests by album directory and rank recency by the newest contained track.
function recency(a: LibraryAlbum) {
  const fromTracks = Array.isArray(a?.tracks)
    ? a.tracks.reduce((m, t) => Math.max(m, Number(t?.dateAdded) || 0), 0)
    : 0;
  return Math.max(fromTracks, Number(a?.dateAdded) || 0);
}
// The most recently added track; the song that drove this album's recency.
function newestTrack(a: LibraryAlbum) {
  if (!Array.isArray(a?.tracks) || a.tracks.length === 0) return null;
  return a.tracks.reduce(
    (best, t) => ((Number(t?.dateAdded) || 0) > (Number(best?.dateAdded) || 0) ? t : best),
    a.tracks[0],
  );
}

// Persist hidden albums and pin order without changing the library.
// New albums still precede manual pins so hand ordering cannot bury arrivals.
const LAYOUT_KEY = "krobi.recentAlbums.layout";
type Layout = { hidden: string[]; pins: { album: string; track: string }[]; editedAt: number };
type Entry = { key: string; album: LibraryAlbum; track: LibraryTrack | null };
type Press = { key: string; pointerId: number; x: number; y: number };
type Drag = Press & { grabX: number; grabY: number };
const EMPTY_LAYOUT: Layout = { hidden: [], pins: [], editedAt: 0 };
const albumKey = (a: LibraryAlbum) => String(a?.path || a?.album || "");

function readLayout(): Layout {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_LAYOUT;
    const value = raw as Record<string, unknown>;
    return {
      hidden: Array.isArray(value.hidden) ? value.hidden.filter((k) => typeof k === "string") : [],
      pins: Array.isArray(value.pins)
        ? value.pins.filter((p): p is Layout["pins"][number] => typeof p === "object" && p !== null && "album" in p && typeof p.album === "string" && "track" in p && typeof p.track === "string")
        : [],
      editedAt: Number(value.editedAt) || 0,
    };
  } catch {
    return EMPTY_LAYOUT;
  }
}
function writeLayout(layout: Layout) {
  try {
    if (layout.hidden.length || layout.pins.length) localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    else localStorage.removeItem(LAYOUT_KEY);
  } catch {
    /* private window / blocked storage: the choice lasts this session only */
  }
}

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// How far a press must travel before it becomes a drag (a click stays a click).
const DRAG_SLOP = 6;

// Close = three beats: the tile shrinks away, the rest slide into the gap
// (FLIP), then the album that was next fades in at the end. A pin runs the same
// FLIP the other way: everything slides one place on, the pinned song appears
// first, and the last tile drops off.
// Timings are motion roles (ui/react/motion.ts): leave = exit, slide = move,
// the newcomer = move too, so it lands as the slide settles. All 0 under reduced motion.

// Fit both rows and their titles inside PANEL_MAX by sizing covers before gaps.
// Reserve 62px for the header/borders, 24px for padding, 8px for the row gap and 44px for labels.
const PANEL_MAX = "min(58vh, 520px)";
const GAP = 8;
// Never a bigger cover than Browse's (FillGrid's 128px minimum): a narrow
// window shows more, smaller covers rather than three huge ones.
const MAX_SIDE = 128;
// The cover side that lets two rows fit in PANEL_MAX, in px (same terms as above).
const fitSide = () => (Math.min(window.innerHeight * 0.58, 520) - 62 - 24 - GAP) / 2 - 44;

export default function RecentAlbums({ albums = [], loaded = true, limit = 8, compact = false, fit = false, snapshotAt = null }: { albums?: LibraryAlbum[]; loaded?: boolean; limit?: number; compact?: boolean; fit?: boolean; snapshotAt?: number | null }) {
  const { t } = useTranslation();
  const { play, addToQueue, addNextInQueue, selectedTrack, isPlaying, setIsPlaying } = useAudioPlayer();
  const { showSuccess, showError } = useStatus();
  const [layout, setLayout] = useState(readLayout);
  // Fit: as many columns as covers of fitSide() fit across the panel.
  const body = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(5);
  useLayoutEffect(() => {
    if (!fit || !body.current) return;
    const el = body.current;
    const measure = () => {
      const width = el.clientWidth - 24;
      setCols(Math.max(2, Math.floor((width + GAP) / (Math.min(MAX_SIDE, Math.max(60, fitSide())) + GAP))));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("resize", measure); };
  }, [fit]);
  const shown = fit ? cols * 2 : limit;
  const [leaving, setLeaving] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  // Mounted from the first opening on, so closing can animate out.
  const pickerMounted = useHeld(picking || null);
  // While a tile is being dragged: the live order of keys, before it is saved.
  const [dragOrder, setDragOrder] = useState<string[] | null>(null);
  // Tiles are keyed by album, so an album that was already on screen and gets
  // pinned slides from its old slot to the front instead of popping.
  const recent = useMemo(() => {
    const gone = new Set(layout.hidden);
    const byKey = new Map(albums.map((a) => [albumKey(a), a]));
    const pinned = layout.pins.flatMap(({ album: key, track: path }) => {
      const album = byKey.get(key);
      const track = album?.tracks?.find((tr) => tr?.path === path);
      return album && track ? [{ key, album, track }] : [];
    });
    const taken = new Set(pinned.map((p) => p.key));
    const natural = [...albums]
      .sort((x, y) => recency(y) - recency(x))
      .filter((a) => !gone.has(albumKey(a)) && !taken.has(albumKey(a)))
      .map((a) => ({ key: albumKey(a), album: a, track: newestTrack(a) }));
    const since = Number(layout.editedAt) || 0;
    const fresh = pinned.length ? natural.filter((n) => recency(n.album) > since) : [];
    const rest = pinned.length ? natural.filter((n) => recency(n.album) <= since) : natural;
    const list = [...fresh, ...pinned, ...rest].slice(0, shown);
    if (!dragOrder) return list;
    const at = new Map(dragOrder.map((k, i) => [k, i]));
    return [...list].sort((x, y) => (at.get(x.key) ?? 1e9) - (at.get(y.key) ?? 1e9));
  }, [albums, shown, layout, dragOrder]);
  const shownTracks = useMemo(
    () => new Set(recent.map((r) => r.track?.path).filter((path): path is string => !!path)),
    [recent],
  );

  // FLIP bookkeeping: each tile's element by album key, and where every tile
  // stood just before a close/reset changed the list.
  const tiles = useRef(new Map<string, HTMLDivElement>());
  const before = useRef<Map<string, DOMRect> | null>(null);
  const grid = useRef<HTMLDivElement>(null);
  // The tile under the pointer: { key, pointerId, grabX, grabY, x, y }.
  const drag = useRef<Drag | null>(null);

  const snapshot = (skip?: string) =>
    new Map(
      [...tiles.current]
        .filter(([k]) => k !== skip)
        .map(([k, el]) => [k, el.getBoundingClientRect()]),
    );

  // Keep the dragged tile under the pointer. Measured from its *layout* slot
  // (offsetLeft/Top ignore transforms), so it stays glued after a reorder
  // moves that slot.
  const positionDragged = () => {
    const d = drag.current;
    const el = d && tiles.current.get(d.key);
    if (!el || !grid.current) return;
    const g = grid.current.getBoundingClientRect();
    const x = d.x - g.left - d.grabX - el.offsetLeft;
    const y = d.y - g.top - d.grabY - el.offsetTop;
    el.style.transform = `translate(${x}px, ${y}px)`;
  };
  const tileRef = (key: string) => (el: HTMLDivElement | null) => {
    if (el) tiles.current.set(key, el);
    else tiles.current.delete(key);
  };

  const commitLayout = useCallback((next: Layout) => {
    if (!reducedMotion()) before.current = snapshot();
    writeLayout(next);
    setLayout(next);
  }, []);

  useLayoutEffect(() => {
    positionDragged();
    const prev = before.current;
    if (!prev) return;
    before.current = null;
    for (const [key, el] of tiles.current) {
      if (key === drag.current?.key) continue;
      const was = prev.get(key);
      if (was) {
        const now = el.getBoundingClientRect();
        const dx = was.left - now.left;
        const dy = was.top - now.top;
        if (dx || dy) {
          el.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
            motion("move"),
          );
        }
      } else {
        // Newcomer: waits for the slide, then appears in the freed slot.
        el.animate(
          [
            { opacity: 0, transform: "scale(0.85)" },
            { opacity: 1, transform: "none" },
          ],
          { ...motion("move"), delay: motion("move").duration, fill: "backwards" },
        );
      }
    }
  }, [recent]);

  const handleClose = (key: string) => {
    if (!key || leaving) return;
    const next = {
      ...layout,
      hidden: [...layout.hidden, key],
      pins: layout.pins.filter((p) => p.album !== key),
    };
    const el = tiles.current.get(key);
    if (!el || reducedMotion()) {
      commitLayout(next);
      return;
    }
    setLeaving(key);
    const anim = el.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "scale(0.8)" },
      ],
      { ...motion("exit"), fill: "forwards" },
    );
    anim.onfinish = () => {
      // Drop it from the FLIP snapshot so nothing measures the faded tile.
      tiles.current.delete(key);
      setLeaving(null);
      commitLayout(next);
    };
  };

  const handlePick = (album: LibraryAlbum, track: LibraryTrack) => {
    const key = albumKey(album);
    setPicking(false);
    if (!key || !track?.path) return;
    commitLayout({
      ...layout,
      hidden: layout.hidden.filter((k) => k !== key),
      pins: [{ album: key, track: track.path }, ...layout.pins.filter((p) => p.album !== key)],
      editedAt: Date.now() / 1000,
    });
  };

  // The order the panel showed when the drag began: a press that ends where it
  // started changes nothing and must not pin the whole panel.
  const layoutOrder = useRef("");
  useEffect(() => {
    if (!dragOrder) layoutOrder.current = recent.map((r) => r.key).join("|");
  }, [recent, dragOrder]);

  // Require pointer travel before dragging so clicks still open or play.
  // Hit-test layout boxes so animated tiles cannot make the order oscillate.
  const pending = useRef<Press | null>(null);
  const swallowClick = useRef(false);
  const onTilePointerDown = (key: string) => (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || drag.current || leaving || recent.length < 2) return;
    if ((e.target instanceof Element ? e.target : null)?.closest(".cover-card__overlay button")) return;
    pending.current = { key, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const beginDrag = (p: Press, e: React.PointerEvent<HTMLDivElement>) => {
    const el = tiles.current.get(p.key);
    if (!el) return;
    el.setPointerCapture?.(p.pointerId);
    const r = el.getBoundingClientRect();
    drag.current = { key: p.key, pointerId: p.pointerId, grabX: p.x - r.left, grabY: p.y - r.top, x: e.clientX, y: e.clientY };
    el.style.zIndex = "20";
    el.style.transition = "none";
    setDragOrder(recent.map((r) => r.key));
  };
  const onTileClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!swallowClick.current) return;
    swallowClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  const onTilePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pending.current;
    if (p && !drag.current && e.pointerId === p.pointerId) {
      if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_SLOP) return;
      pending.current = null;
      beginDrag(p, e);
      return;
    }
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId || !grid.current || !dragOrder) return;
    d.x = e.clientX;
    d.y = e.clientY;
    positionDragged();
    const g = grid.current.getBoundingClientRect();
    const px = e.clientX - g.left;
    const py = e.clientY - g.top;
    let over = null;
    for (const [k, el] of tiles.current) {
      if (px >= el.offsetLeft && px < el.offsetLeft + el.offsetWidth && py >= el.offsetTop && py < el.offsetTop + el.offsetHeight) {
        over = k;
        break;
      }
    }
    if (!over || over === d.key) return;
    const next = dragOrder.filter((k) => k !== d.key);
    next.splice(dragOrder.indexOf(over), 0, d.key);
    if (!reducedMotion()) before.current = snapshot(d.key);
    setDragOrder(next);
  };

  const onTilePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    pending.current = null;
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    swallowClick.current = true;
    window.setTimeout(() => { swallowClick.current = false; }, 0);
    const el = tiles.current.get(d.key);
    const byKey = new Map(recent.map((r) => [r.key, r]));
    const pins = (dragOrder || [])
      .map((k) => byKey.get(k))
      .filter((r): r is Entry & { track: LibraryTrack } => !!r?.track?.path)
      .map((r) => ({ album: r.key, track: r.track.path }));
    const moved = dragOrder !== null && dragOrder.join("|") !== layoutOrder.current;
    // Snapshot first (the dragged tile's rect is where the pointer left it),
    // then let go of it: the FLIP glides it into its slot.
    drag.current = null;
    if (moved) {
      commitLayout({ ...layout, pins, editedAt: Date.now() / 1000 });
    } else if (!reducedMotion()) {
      before.current = snapshot();
    }
    if (el) {
      el.style.transform = "";
      el.style.zIndex = "";
      el.style.transition = "";
    }
    setDragOrder(null);
  };

  // "Move to the front": the keyboard's way to reorder; the panel's current
  // order with this tile first, saved like a drag.
  const moveToFront = (key: string) => {
    const order = [key, ...recent.map((r) => r.key).filter((k) => k !== key)];
    const byKey = new Map(recent.map((r) => [r.key, r]));
    const pins = order
      .map((k) => byKey.get(k))
      .filter((r): r is Entry & { track: LibraryTrack } => !!r?.track?.path)
      .map((r) => ({ album: r.key, track: r.track.path }));
    commitLayout({ ...layout, pins, editedAt: Date.now() / 1000 });
  };

  const customized = layout.hidden.length > 0 || layout.pins.length > 0;
  const handleReset = () => {
    if (customized && !leaving) commitLayout(EMPTY_LAYOUT);
  };

  // Play the chip's song and queue the rest of its album behind it (matching the
  // Library "Just added" rail, which starts a track and queues the album).
  const handlePlay = (album: LibraryAlbum, track: LibraryTrack | null) => {
    if (!track) return;
    const rest = (album?.tracks || []).filter((t) => t?.path !== track.path);
    play(decorate(track as ListedTrack, album as Parameters<typeof decorate>[1]), {
      replaceQueue: true,
      upcomingTracks: rest.map((t) => decorate(t as ListedTrack, album as Parameters<typeof decorate>[1])),
    });
  };

  //  right-click menu on a tile: the tile's song, same actions as a
  // Library row where they make sense here, plus the panel's own two
  const [ctx, setCtx] = useState<{ open: boolean; x: number; y: number; entry: Entry | null }>({ open: false, x: 0, y: 0, entry: null });
  const [lyricsTrack, setLyricsTrack] = useState<PlayerTrack | null>(null);
  const ctxEntry = ctx.entry;
  const ctxSong = useMemo(
    () => (ctxEntry?.track ? [decorate(ctxEntry.track as ListedTrack, ctxEntry.album as Parameters<typeof decorate>[1])] : []),
    [ctxEntry],
  );
  const playlistMenu = useAddToPlaylistMenu({ showSuccess, showError });
  const openCtx = (entry: Entry) => (e: React.MouseEvent) => {
    if (dragOrder || !entry?.track) return;
    e.preventDefault();
    setCtx({ open: true, ...menuPointFrom(e), entry });
    playlistMenu.refresh();
  };
  const closeCtx = useCallback(() => setCtx((c) => ({ ...c, open: false })), []);

  const songMenu = useSongMenu(ctxSong, { showSuccess, showError });
  const ctxItems = ctxEntry ? songMenu.build({
    onPlay: () => handlePlay(ctxEntry.album, ctxEntry.track),
    onPlayNext: () => addNextInQueue(ctxSong),
    onQueue: () => addToQueue(ctxSong),
    playlistSubmenu: playlistMenu.submenu(ctxSong),
    onOpenLyrics: () => setLyricsTrack(ctxSong[0]),
    extras: [
      { label: t("Play the album"), color: SONG_ACTION_COLOR.playAlbum, disabled: !((ctxEntry.album?.tracks?.length ?? 0) > 1), onClick: () => handlePlay(ctxEntry.album, ctxEntry.album.tracks![0]) },
      { label: t("Choose another song…"), color: SONG_ACTION_COLOR.chooseSong, onClick: () => setPicking(true) },
      { label: t("Move to the front"), color: SONG_ACTION_COLOR.moveToFront, disabled: recent[0]?.key === ctxEntry.key, onClick: () => moveToFront(ctxEntry.key) },
      { label: t("Remove from Home"), color: SONG_ACTION_COLOR.removeFromHome, onClick: () => handleClose(ctxEntry.key) },
    ],
  }) : [];

  return (
    <section className={`bg-panel border-2 border-black rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] overflow-hidden ${compact ? "h-full flex flex-col" : ""}`}>
      <PanelHeader
        title={t("Recently added")}
        accent="var(--yellow)"
        actions={
          <>
            <SnapshotAge at={snapshotAt} />
            <button
              type="button"
              onClick={() => setPicking(true)}
              disabled={albums.length === 0}
              aria-label={t("Choose song")}
              title={t("Choose song")}
              className={PANEL_ICON_BUTTON}
            >
              <ListMusic className="w-3.5 h-3.5" aria-hidden />
            </button>
            <button
              type="button"
              onClick={handleReset}
              disabled={!customized}
              aria-label={t("Reset order")}
              title={t("Reset order")}
              className={PANEL_ICON_BUTTON}
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden />
            </button>
          </>
        }
      />
      <div ref={body} className={`${fit ? "p-3" : compact ? "p-3 flex-1 min-h-0 overflow-y-auto slim-scrollbar" : "p-4"}`}>
        {!loaded ? <ContentPlaceholder count={5} /> : recent.length === 0 ? (
          <div className="text-sm text-[var(--ink-3)] py-8 text-center">
            {t("No albums yet. Import music to get started.")}
          </div>
        ) : (
          <div
            ref={grid}
            className={`relative grid gap-2 ${fit ? "" : compact ? "grid-cols-5" : "grid-cols-3"}`}
            style={fit ? { gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` } : undefined}
          >
            {recent.map(({ key: albumId, album: a, track }, i) => {
              const song = (track?.title || a?.album || t("Album")).toString();
              const key = albumId || `${song}-${i}`;
              const current = Boolean(track && selectedTrack?.path === track.path);
              return (
                <CoverCard
                  key={key}
                  cardRef={tileRef(key)}
                  onPointerDown={onTilePointerDown(key)}
                  onPointerMove={onTilePointerMove}
                  onPointerUp={onTilePointerUp}
                  onPointerCancel={onTilePointerUp}
                  onClickCapture={onTileClickCapture}
                  className={`${leaving === key ? "pointer-events-none" : ""} ${dragOrder ? "select-none" : ""} ${fit ? "shrink-0" : ""}`}
                  cover={<CoverTile src={a?.cover || buildAlbumCoverUrl(a)} label={song} fontSize="24px" />}
                  title={song}
                  subtitle={track?.artist || a?.artist || undefined}
                  onOpen={() => openLibraryAlbum(a)}
                  openLabel={t("Open the album of {{song}}", { song })}
                  play={
                    track
                      ? {
                          onPlay: () => handlePlay(a, track),
                          current,
                          playing: isPlaying,
                          onToggle: () => setIsPlaying(!isPlaying),
                          seed: a?.album || song,
                        }
                      : undefined
                  }
                  onMenu={openCtx({ key: albumId, album: a, track })}
                  menuOpen={ctx.open && ctxEntry?.key === albumId}
                />
              );
            })}
          </div>
        )}
      </div>
      <TrackContextMenu
        open={ctx.open}
        x={ctx.x}
        y={ctx.y}
        title={ctxEntry?.track?.title || ctxEntry?.album?.album}
        artist={ctxEntry?.track?.artist || ctxEntry?.album?.artist || ""}
        items={ctxItems}
        onClose={closeCtx}
      />
      <LyricsModal
        open={!!lyricsTrack}
        relPath={lyricsKeyOf(lyricsTrack)}
        track={lyricsTrack}
        onClose={() => setLyricsTrack(null)}
      />
      {pickerMounted && (
        <RecentPickerModal
          open={picking}
          albums={albums}
          shownTracks={shownTracks}
          onPick={handlePick}
          onClose={() => setPicking(false)}
        />
      )}
    </section>
  );
}
