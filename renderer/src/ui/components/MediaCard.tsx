/**
 * Owns album, artist and playlist cards and their fallback cover art.
 * Cards navigate by provider/id when an open handler is available.
 * Callers supply list or grid wrappers; the card owns no rail layout.
 * Use shared CoverCard/CoverTile primitives and theme tokens for every surface.
 * Keep fallback-art helpers in cardArt so this module exports only components.
 */
import type { CSSProperties, ReactNode } from "react";
import CoverCard from "./CoverCard";
import CoverTile from "./CoverTile";

/**
 * Cover art with a graceful failure, for a page's header (the artist, genre or
 * playlist at the top of a browse page). Cards use CoverCard below.
 *
 * Remote art fails routinely; CDN hiccups, dead covers, an offline machine —
 * so a broken load becomes a coloured initials tile rather than a torn <img>.
 */
export function CardArt({ title, imageUrl, round = false, size = 152, badge = null }: { title: string; imageUrl?: string | null; round?: boolean; size?: number; badge?: ReactNode }) {
  return (
    <div
      className={`relative overflow-hidden grid place-items-center shrink-0 ${round ? "rounded-full" : "rounded-[var(--r-md)]"}`}
      style={{ width: size, height: size, border: "2px solid var(--line)", boxShadow: "var(--shadow-pop)" }}
    >
      <CoverTile src={imageUrl} label={title} fontSize={`${Math.round(size * 0.28)}px`} className="w-full h-full" />
      {badge}
    </div>
  );
}

/**
 * One catalog card; Browse's albums, artists and playlists. The shared
 * CoverCard (the same card as Home and Library): the cover and title open
 * the item; an artist's cover is round. `onOpen` is what makes it openable.
 */
export function MediaCard({ title, subtitle, imageUrl, kind = "album", size = 152, onOpen, titleHint }: { title: string; subtitle?: ReactNode; imageUrl?: string | null; kind?: string; size?: number | string; onOpen?: () => void; titleHint?: string }) {
  const clickable = typeof onOpen === "function";
  // `size` may be "100%" (a card that fills its grid cell); the initials are
  // then sized for a typical cover.
  const side = typeof size === "number" ? size : 128;
  return (
    <CoverCard
      size={size}
      round={kind === "artist"}
      disabled={!clickable}
      cover={<CoverTile src={imageUrl} label={title} fontSize={`${Math.round(side * 0.28)}px`} />}
      title={title}
      openLabel={titleHint || undefined}
      subtitle={subtitle || undefined}
      onOpen={clickable ? onOpen : () => {}}
    />
  );
}

/** A wrapping grid for catalog cards. */
export function CardGrid({ children, min = 152 }: { children?: ReactNode; min?: number }) {
  return (
    <ul
      className="list-none p-0 m-0 grid gap-x-4 gap-y-5"
      style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))` }}
    >
      {children}
    </ul>
  );
}

/** A horizontal scroller; the shape every existing browse surface uses. */
export function CardRail({ children }: { children?: ReactNode }) {
  return (
    <ul className="list-none p-0 m-0 flex gap-3.5 overflow-x-auto snap-x custom-scrollbar pb-2">
      {children}
    </ul>
  );
}

/** Grid/rail cell. Kept out of `MediaCard` so the card works in both. */
export function CardCell({ children, width, snap = false }: { children?: ReactNode; width?: CSSProperties["width"]; snap?: boolean }) {
  return (
    <li className={snap ? "shrink-0 snap-start" : ""} style={width ? { width } : undefined}>
      {children}
    </li>
  );
}

/** The provider attribution pill. */
export function ProviderChip({ name, accent = "var(--purple)" }: { name?: string; accent?: string }) {
  if (!name) return null;
  return (
    <span
      // self-start matters: `inline-flex` does not stop a flex *item* from
      // stretching along the cross axis, so inside a flex-col header this chip
      // otherwise spans the full width as an empty bar.
      className="inline-flex self-start items-center gap-1.5 shrink-0 px-2 py-[3px] rounded-full border-2 border-black bg-panel text-[11px] font-bold leading-none whitespace-nowrap"
      title={`Datos proporcionados por ${name}`}
    >
      <span className="w-2 h-2 rounded-full border border-black" style={{ background: accent }} aria-hidden />
      {name}
    </span>
  );
}
