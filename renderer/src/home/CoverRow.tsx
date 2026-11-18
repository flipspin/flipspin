import React, { type ComponentType, type MouseEvent, type ReactNode } from "react";
import CoverCard, { type CoverCardPlay } from "../ui/components/CoverCard";
import { ContentPlaceholder } from "../ui/components/ContentPlaceholder";
import PanelHeader from "../ui/components/PanelHeader";

// Home's one-row shelves ("Your playlists", "Most played"): a panel whose
// cards scroll sideways. Each card is the shared CoverCard: the cover opens,
// the disc plays, "⋯" and a right-click open the same menu.

const TILE_SIZE = 140;

type RowPanelProps = { title: ReactNode; accent: string; children?: ReactNode; actions?: ReactNode };

export function RowPanel({ title, accent, children, actions }: RowPanelProps) {
  return (
    // flex-none: inside Home's scrolling column a shrinkable panel was
    // squeezed below its covers instead of the column scrolling.
    <section className="flex-none bg-panel border-2 border-black rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] overflow-hidden flex flex-col">
      <PanelHeader title={title} accent={accent} actions={actions} />
      {children}
    </section>
  );
}

/** An invisible card that holds a shelf at its filled height, so an empty
 *  panel does not jump when its first cover arrives. */
export function ShelfGhost({ size }: { size?: number }) {
  return (
    <div aria-hidden inert className="invisible pointer-events-none">
      {/* <br/> holds each text line's height without adding readable text. */}
      <CoverCard size={size} cover={<span />} title="" titleContent={<br />} subtitle={<br />} onOpen={() => {}} menuButton={false} />
    </div>
  );
}

/** `empty` shows when there are no tiles: a small cover-shaped icon and a line. */
type RowScrollerProps = {
  children?: ReactNode;
  icon?: ComponentType<{ className?: string; strokeWidth?: number }>;
  empty: ReactNode;
  loading?: boolean;
};

export function RowScroller({ children, icon: Icon, empty, loading = false }: RowScrollerProps) {
  if (loading) return <ContentPlaceholder />;
  if (React.Children.count(children) === 0) {
    return (
      <div className="relative flex px-3 pt-3 pb-4 text-[var(--ink-3)]">
        <ShelfGhost size={TILE_SIZE} />
        <div className="absolute inset-0 flex items-center justify-center gap-3">
          <span aria-hidden className="grid w-10 h-10 flex-none place-items-center rounded-control border-2 border-dashed border-current opacity-70">
            {Icon && <Icon className="w-5 h-5" strokeWidth={2} />}
          </span>
          <span className="text-sm">{empty}</span>
        </div>
      </div>
    );
  }
  // Bottom padding leaves room for the tiles' offset shadow and the scrollbar.
  return <div className="flex gap-4 overflow-x-auto overflow-y-hidden slim-scrollbar px-3 pt-3 pb-4">{children}</div>;
}

/** A shelf card: the shared CoverCard at the shelf's fixed width. */
type RowTileProps = {
  cover: ReactNode;
  title: string;
  subtitle?: string | null;
  onOpen: () => void;
  openLabel?: string;
  /** Omit for an item that cannot play (an empty playlist). */
  play?: CoverCardPlay;
  onMenu: (e: MouseEvent) => void;
  menuButton?: boolean;
  menuOpen?: boolean;
};

export function RowTile({ cover, title, subtitle, onOpen, openLabel, play, onMenu, menuButton, menuOpen = false }: RowTileProps) {
  return (
    <CoverCard
      className="flex-none"
      size={TILE_SIZE}
      cover={cover}
      title={title}
      subtitle={subtitle ?? undefined}
      onOpen={onOpen}
      openLabel={openLabel}
      play={play}
      onMenu={onMenu}
      menuButton={menuButton}
      menuOpen={menuOpen}
    />
  );
}
