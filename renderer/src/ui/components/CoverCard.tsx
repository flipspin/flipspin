import type { CSSProperties, HTMLAttributes, MouseEvent, ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";
import { MoreHorizontal } from "lucide-react";
import { artColorFor } from "./cardArt";
import "./cover-card.css";

/** Keep open and play actions separate so resuming does not reopen or restart an item.
 * Share menu handling between the overflow button and right-click. */
export type CoverCardPlay = {
  onPlay: () => void;
  /** This item is what the player has loaded. */
  current?: boolean;
  /** …and it is playing (not paused). */
  playing?: boolean;
  /** Pause / resume, used instead of `onPlay` on the current item. */
  onToggle?: () => void;
  /** The disc label's colour seed (the album name). */
  seed?: string;
};

type CoverCardProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  /** The art node (CoverTile / CoverMosaic), sized to fill a square. */
  cover: ReactNode;
  title: string;
  /** Optional highlighted title; the plain title remains the accessible tooltip. */
  titleContent?: ReactNode;
  subtitle?: ReactNode;
  onOpen: () => void;
  /** Accessible name of the open button; defaults to the title. */
  openLabel?: string;
  /** Omit for an item that cannot play (an empty playlist). */
  play?: CoverCardPlay;
  onMenu?: (e: MouseEvent) => void;
  /** Song cards keep the context menu without a visible overflow button. */
  menuButton?: boolean;
  menuOpen?: boolean;
  /** Cover width; the card is the cover's width. Omit to fill the cell. */
  size?: number | string;
  /** A round cover (an artist). */
  round?: boolean;
  /** Shown but disabled when entity navigation is unavailable. */
  disabled?: boolean;
  cardRef?: Ref<HTMLDivElement>;
};

export default function CoverCard({
  cover,
  title,
  titleContent,
  subtitle,
  onOpen,
  openLabel,
  play,
  onMenu,
  menuButton = true,
  menuOpen = false,
  size,
  round = false,
  disabled = false,
  cardRef,
  className = "",
  style,
  ...rest
}: CoverCardProps) {
  const { t } = useTranslation();
  const current = Boolean(play?.current);
  const playing = current && Boolean(play?.playing);
  const playLabel = current
    ? playing ? t("Pause {{song}}", { song: title }) : t("Resume {{song}}", { song: title })
    : t("Play {{song}}", { song: title });
  const sized: CSSProperties | undefined = size != null ? { width: size, ...style } : style;

  return (
    <div
      {...rest}
      ref={cardRef}
      className={`cover-card ${className}`}
      style={sized}
      data-menu-open={menuOpen || undefined}
      data-current={current || undefined}
      data-round={round || undefined}
      data-disabled={disabled || undefined}
      onContextMenu={onMenu}
    >
      <button type="button" className="cover-card__open" onClick={onOpen} aria-label={openLabel} title={title} disabled={disabled}>
        <span className="cover-card__art">{cover}</span>
        <span className="cover-card__title">{titleContent ?? title}</span>
        {subtitle != null && subtitle !== "" && <span className="cover-card__sub">{subtitle}</span>}
      </button>
      {/* A square over the cover: the controls are placed against it. */}
      <div className="cover-card__overlay">
        {onMenu && menuButton && (
          <button
            type="button"
            className="cover-card__more"
            onClick={onMenu}
            aria-label={t("More options")}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title={t("More options")}
          >
            <MoreHorizontal className="w-4 h-4" strokeWidth={2.5} aria-hidden />
          </button>
        )}
        {play && (
          <button
            type="button"
            className="cover-card__disc"
            onClick={() => (current && play.onToggle ? play.onToggle() : play.onPlay())}
            aria-label={playLabel}
            aria-pressed={current ? playing : undefined}
            title={playLabel}
          >
            <span
              aria-hidden
              className={`krobi-disc ${playing ? "krobi-disc--spinning" : ""}`}
              style={{ "--disc-label": artColorFor(play.seed || title) } as CSSProperties}
            />
          </button>
        )}
      </div>
    </div>
  );
}
