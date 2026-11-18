import type { ReactNode } from "react";

/**
 * The Home panel header; a coloured top rule, a square swatch in the same
 * colour, an uppercase title, then an optional count and actions on the right.
 * One component for every panel and panel-styled dialog (RowPanel,
 * "Just added", Jobs, PanelModal), so they cannot drift apart.
 */
type PanelHeaderProps = {
  title: ReactNode;
  /** A theme colour token for the rule and the swatch, e.g. "var(--purple)". */
  accent: string;
  /** Set when a dialog is labelled by this title. */
  titleId?: string;
  /** A small mono figure right after the title (a count). */
  count?: ReactNode;
  /** Right-aligned controls. */
  actions?: ReactNode;
};

export default function PanelHeader({ title, accent, titleId, count, actions }: PanelHeaderProps) {
  return (
    <div className="bg-panel border-b-2 border-black border-t-4 p-3 flex items-center gap-2 flex-shrink-0 min-w-0" style={{ borderTopColor: accent }}>
      <span className="w-3.5 h-3.5 shrink-0 rounded-tight border-2 border-black" style={{ background: accent }} aria-hidden />
      <h3 id={titleId} className="font-bold text-lg tracking-tight uppercase truncate">
        {title}
      </h3>
      {count != null && <span className="font-mono text-[12px] text-[var(--ink-3)]">{count}</span>}
      {actions != null && <div className="ml-auto flex items-center gap-2">{actions}</div>}
    </div>
  );
}

/** The small square icon button panel headers carry (reset, pick, close). */
export const PANEL_ICON_BUTTON =
  "min-h-0 p-1.5 rounded-control border-2 border-black bg-panel text-black leading-none cursor-pointer hover:bg-[var(--yellow)] active:translate-y-px disabled:opacity-30 disabled:cursor-default disabled:hover:bg-panel";
