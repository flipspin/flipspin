import React, { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import { buildAlbumCoverUrl } from "@lib/api";
import CoverTile from "../ui/components/CoverTile";
import CoverCard from "../ui/components/CoverCard";

/** Virtualize album rows: cover-heavy grids are expensive in WebKit.
 * Columns follow the scroller width, and useLibraryView owns filtering and order. */
type Album = {
  path?: string;
  album?: string;
  artist?: string;
  year?: string | number;
  cover?: string;
  tracks: { path: string }[];
  totalTracks?: number;
};

type Props = {
  albums: Album[];
  playingAlbumId: string | null;
  isPlaying: boolean;
  albumIdOf: (a: Album) => string;
  onOpen: (album: Album) => void;
  onPlay: (album: Album) => void;
  onTogglePlay: () => void;
  onContextMenu: (album: Album, e: React.MouseEvent) => void;
  /** The scroller the grid sits in; a long grid draws only its visible rows. */
  scrollRef?: RefObject<HTMLElement | null>;
};

/* Mirrors .library-grid (index.css): auto-fill columns of at least 156 px. */
const MIN_CARD = 156;
const GAP_X = 16;
const GAP_Y = 20;
const PAD = 16;
/** Above this many albums only the rows on screen are drawn. */
const VIRTUAL_FROM = 60;

/** How many columns `.library-grid` lays out at the scroller's width. */
function useColumns(scrollRef?: RefObject<HTMLElement | null>): { columns: number; card: number } {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef?.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth - (parseFloat(getComputedStyle(el).paddingRight) || 0));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [scrollRef]);
  const inner = Math.max(0, width - 2 * PAD);
  const columns = Math.max(1, Math.floor((inner + GAP_X) / (MIN_CARD + GAP_X)));
  return { columns, card: (inner - GAP_X * (columns - 1)) / columns };
}

export default function AlbumGrid({ albums, playingAlbumId, isPlaying, albumIdOf, onOpen, onPlay, onTogglePlay, onContextMenu, scrollRef }: Props) {
  const { t } = useTranslation();
  const { columns, card } = useColumns(scrollRef);
  // A row is one card tall: the square cover plus its two text lines. The
  // guess is corrected from the first rendered row.
  const [rowHeight, setRowHeight] = useState(0);
  const firstRow = useRef<HTMLLIElement | null>(null);
  const estimate = rowHeight || Math.round(card + 52);
  const virtual = !!scrollRef && albums.length > VIRTUAL_FROM && card > 0;
  const rows = Math.ceil(albums.length / columns);
  const virtualizer = useVirtualizer({
    count: virtual ? rows : 0,
    getScrollElement: () => scrollRef?.current ?? null,
    estimateSize: () => estimate + GAP_Y,
    overscan: 3,
    initialOffset: () => scrollRef?.current?.scrollTop ?? 0,
    useFlushSync: false,
  });
  useLayoutEffect(() => {
    const h = firstRow.current?.offsetHeight;
    if (h && Math.abs(h - rowHeight) > 0.5) setRowHeight(h);
  });
  useLayoutEffect(() => { virtualizer.measure(); }, [estimate, columns, virtualizer]);

  if (albums.length === 0) {
    return <p className="retro-song-table__empty">{t("No album matches")}</p>;
  }
  const items = virtual ? virtualizer.getVirtualItems() : null;
  const from = items?.length ? items[0].index * columns : 0;
  const to = items?.length ? Math.min(albums.length, (items[items.length - 1].index + 1) * columns) : albums.length;
  const shown = virtual ? albums.slice(from, to) : albums;
  const list = (
    <ul className="library-grid" style={virtual ? { transform: `translateY(${items?.[0]?.start ?? 0}px)` } : undefined}>
      {shown.map((a, i) => {
        const id = albumIdOf(a);
        const name = a.album || t("Album");
        const current = playingAlbumId === id;
        const shown = a.tracks.length;
        const total = a.totalTracks ?? shown;
        const count =
          shown === total
            ? t("{{n}} songs", { count: total, n: total })
            : t("{{shown}} of {{total}}", { shown, total });
        return (
          <li key={id} ref={i === 0 ? firstRow : undefined}>
            <CoverCard
              cover={<CoverTile src={a.cover || buildAlbumCoverUrl(a)} label={name} fontSize="34px" />}
              title={name}
              openLabel={t("Open {{album}}", { album: name })}
              subtitle={
                <>
                  {a.artist ? <span>{a.artist}</span> : null}
                  <span className="shrink-0">{count}</span>
                </>
              }
              onOpen={() => onOpen(a)}
              play={{ onPlay: () => onPlay(a), current, playing: current && isPlaying, onToggle: onTogglePlay, seed: name }}
              onMenu={(e) => onContextMenu(a, e)}
            />
          </li>
        );
      })}
    </ul>
  );
  // A long grid: a box the whole grid's height, the drawn rows moved into place.
  return virtual
    ? <div style={{ height: virtualizer.getTotalSize() - GAP_Y + 2 * PAD, position: "relative" }}>{list}</div>
    : list;
}
