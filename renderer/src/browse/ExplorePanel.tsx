/** Share Home's panel frame so catalog rows use the same layout and controls. */
import { useEffect, useRef, useState, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { ChevronRight, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import { artColorFor, initials } from "../ui/components/cardArt";

/**
 * Home's panel (`LibraryStats`, `RecentAlbums`): accent edge, swatch,
 * uppercase title, optional count and controls on the right.
 */
export function ExplorePanel({ title, accent = "var(--purple)", count = null, right = null, children, className = "", bodyClassName = "p-4" }: { title: ReactNode; accent?: string; count?: number | null; right?: ReactNode; children?: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section
      className={`bg-panel border-2 border-black rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] overflow-hidden flex flex-col min-w-0 ${className}`}
    >
      <div
        className="bg-panel border-b-2 border-black border-t-4 p-3 flex items-center gap-2 flex-shrink-0"
        style={{ borderTopColor: accent }}
      >
        <span className="w-3.5 h-3.5 rounded-tight border-2 border-black shrink-0" style={{ background: accent }} aria-hidden />
        <h2 className="m-0 font-bold text-lg tracking-tight uppercase truncate min-w-0">{title}</h2>
        {count !== null ? (
          <span className="font-mono text-[11px] text-[var(--ink-3)] tabular-nums shrink-0">{count}</span>
        ) : null}
        {right ? <div className="ml-auto flex items-center gap-2 shrink-0">{right}</div> : null}
      </div>
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

/** A small square thumbnail with the coloured-initials fallback. Square even
 *  for artists: the round portrait is the streaming-app tell. */
export function Thumb({ title, imageUrl, size = 44 }: { title: string; imageUrl?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [imageUrl]);
  const showArt = Boolean(imageUrl) && !broken;
  return (
    <span
      className="relative shrink-0 overflow-hidden border-2 border-black rounded-[7px] grid place-items-center shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
      style={{ width: size, height: size, background: showArt ? "var(--panel-2)" : artColorFor(title) }}
      aria-hidden
    >
      {showArt ? (
        <img
          src={imageUrl!}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
          className="w-full h-full object-cover"
        />
      ) : (
        <span
          className="text-black/80 font-extrabold leading-none select-none"
          style={{ fontFamily: "var(--font-display)", fontSize: Math.round(size * 0.32) }}
        >
          {initials(title)}
        </span>
      )}
    </span>
  );
}

/**
 * One line of a ranked list: number, thumbnail, title over subtitle, "›".
 * Clickable when it has `onOpen`.
 */
export function EntityRow({ rank = null, title, subtitle, imageUrl, onOpen, thumb = 44, external = false }: { rank?: number | null; title: string; subtitle?: string | null; imageUrl?: string | null; onOpen?: () => void; thumb?: number; external?: boolean }) {
  const { t } = useTranslation();
  const clickable = typeof onOpen === "function";
  return (
    <li>
      <button
        type="button"
        disabled={!clickable}
        onClick={onOpen}
        title={clickable ? t("Open “{{title}}”", { title }) : title}
        // p-0/min-h-0/bg-transparent/border-0 defeat the global base-button rule;
        // no side padding, so thumbs sit flush with the panel's text.
        className={`explore-entity-row w-full min-h-0 p-0 bg-transparent border-0 text-left flex items-center gap-3 py-[3px] rounded-panel
          ${clickable ? "cursor-pointer" : "cursor-default"}`}
      >
        {rank !== null ? (
          <span className="shrink-0 font-mono text-[12px] text-[var(--ink-3)] tabular-nums">
            {String(rank).padStart(2, "0")}
          </span>
        ) : null}
        <Thumb title={title} imageUrl={imageUrl} size={thumb} />
        <span className="flex flex-col min-w-0 flex-1">
          <span className="truncate text-[13.5px] font-bold text-black">{title}</span>
          {subtitle ? <span className="truncate text-[12px] text-[var(--ink-3)]">{subtitle}</span> : null}
        </span>
        {/* "↗" when the row leaves the app (a podcast opens on Deezer), "›" when it stays. */}
        {clickable ? (
          external ? (
            <ExternalLink size={14} strokeWidth={2.5} className="shrink-0 text-[var(--ink-3)]" aria-hidden />
          ) : (
            <ChevronRight size={15} strokeWidth={2.75} className="shrink-0 text-[var(--ink-3)]" aria-hidden />
          )
        ) : null}
      </button>
    </li>
  );
}

/** The list a run of `EntityRow`s sits in. */
export function EntityList({ children }: { children?: ReactNode }) {
  return <ul className="list-none m-0 p-0 flex flex-col">{children}</ul>;
}

/**
 * First `limit` items, and a footer button for the rest. Panels sit side by
 * side, so twenty rows in one would push its neighbour's end off screen.
 */
export function useShowMore<T>(items: T[] | null | undefined, limit: number) {
  const [open, setOpen] = useState(false);
  const list = items || [];
  const visible = open ? list : list.slice(0, limit);
  const hidden = list.length - visible.length;
  return { visible, open, setOpen, hidden, total: list.length, canToggle: list.length > limit };
}

export function ShowMoreButton({ state, onShowAll }: { state: { canToggle: boolean; open: boolean; setOpen: Dispatch<SetStateAction<boolean>>; total: number }; onShowAll?: () => void }) {
  const { t } = useTranslation();
  if (!state.canToggle && !onShowAll) return null;
  return (
    <button
      type="button"
      onClick={() => onShowAll ? onShowAll() : state.setOpen(!state.open)}
      className="explore-link self-start mt-3"
    >
      {onShowAll ? t("Show all_view") : state.open ? t("See less") : t("See all {{n}}", { n: state.total })}
    </button>
  );
}

/** An artist as a tag: square thumb and name. Many fit in a narrow panel. */
export function ArtistTag({ name, imageUrl, onOpen }: { name: string; imageUrl?: string | null; onOpen?: () => void }) {
  const { t } = useTranslation();
  return (
    <li>
      <button type="button" onClick={onOpen} className="explore-tag" title={t("Open “{{title}}”", { title: name })}>
        <Thumb title={name} imageUrl={imageUrl} size={26} />
        <span className="truncate max-w-[180px]">{name}</span>
      </button>
    </li>
  );
}

export function TagWrap({ children }: { children?: ReactNode }) {
  return <ul className="list-none m-0 p-0 flex flex-wrap gap-2.5">{children}</ul>;
}

/** Measure columns on resize and reveal whole rows so the collapsed grid has no partial final row. */
export function FillGrid<T>({ items, min = 128, rows = 2, gap = 8, renderItem, onShowAll }: { items: T[]; min?: number; rows?: number; gap?: number; renderItem: (item: T, index: number) => ReactNode; onShowAll?: () => void }) {
  const ref = useRef<HTMLUListElement>(null);
  const [columns, setColumns] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    // The same arithmetic as `repeat(auto-fill, minmax(min, 1fr))` with this gap.
    const measure = () => setColumns(Math.max(1, Math.floor((el.clientWidth + gap) / (min + gap))));
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [min, gap]);

  const list = items || [];
  // Before the first measurement, assume a modest width rather than flashing
  // every cover and then snapping back.
  // Whole rows only, even when there are fewer items than `rows` full rows:
  // ten new releases in seven columns show one row of seven and "Ver los 10",
  // not seven and a ragged three. Fewer items than one row show as they are.
  const fit = columns || 4;
  const limit = list.length <= fit ? fit : Math.floor(Math.min(list.length, fit * rows) / fit) * fit;
  const visible = open ? list : list.slice(0, limit);
  const more = { open, setOpen, total: list.length, canToggle: list.length > limit };

  return (
    <>
      <ul
        ref={ref}
        className="list-none p-0 m-0 grid gap-y-3"
        style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, columnGap: gap }}
      >
        {visible.map(renderItem)}
      </ul>
      <ShowMoreButton state={more} onShowAll={onShowAll} />
    </>
  );
}

/** Use circular genre art to distinguish chart navigation from owned albums. */
export function GenreCircle({ name, imageUrl, onOpen, size = 84 }: { name: string; imageUrl?: string | null; onOpen?: () => void; size?: number }) {
  const { t } = useTranslation();
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [imageUrl]);
  const showArt = Boolean(imageUrl) && !broken;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        title={t("Open “{{title}}”", { title: name })}
        className="explore-genre group w-full min-h-0 p-0 bg-transparent border-0 flex flex-col items-center gap-2 cursor-pointer"
      >
        <span
          className="relative overflow-hidden rounded-full border-2 border-black grid place-items-center shadow-[3px_3px_0px_0px_rgba(0,0,0,1)] transition-transform duration-(--dur-fast) group-hover:-translate-y-0.5"
          style={{ width: size, height: size, background: showArt ? "var(--panel-2)" : artColorFor(name) }}
          aria-hidden
        >
          {showArt ? (
            <img src={imageUrl!} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="w-full h-full object-cover" />
          ) : (
            <span className="text-black/80 font-extrabold" style={{ fontFamily: "var(--font-display)", fontSize: Math.round(size * 0.3) }}>
              {initials(name)}
            </span>
          )}
        </span>
        <span className="text-[12.5px] font-bold text-black text-center leading-tight max-w-full truncate">{name}</span>
      </button>
    </li>
  );
}
