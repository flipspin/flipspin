import { useId, type ReactNode, type KeyboardEventHandler } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { ModalLayer, type ModalLayerProps } from "../react/components/ModalLayer";
import PanelHeader from "./PanelHeader";

/**
 * A modal dressed like the Home panels: card, 2px ink border, hard shadow,
 * a coloured top rule and a square swatch before an uppercase title.
 *
 * A skin on `ModalLayer`, which owns the behaviour: portal, focus trap and
 * return, inert background, innermost-wins Escape and backdrop press, and the
 * enter/exit motion. Pass `open` to get the exit animation; a caller that
 * unmounts it instead simply closes without one.
 */
interface PanelModalProps {
  className?: string;
  open?: boolean;
  dismissible?: boolean;
  role?: ModalLayerProps["role"];
  scrimStyle?: ModalLayerProps["scrimStyle"];
  "aria-describedby"?: string;
  title: ReactNode;
  onClose: () => void;
  onKeyDownCapture?: KeyboardEventHandler<HTMLDivElement>;
  /** A theme colour token for the top rule and swatch, e.g. "var(--teal)". */
  accent?: string;
  /** Tailwind max-width class for the card. */
  width?: string;
  /** Right side of the header, before the close button (a count, a badge). */
  headerExtra?: ReactNode;
  /** Pinned between the header and the scrolling body (a search field). */
  toolbar?: ReactNode;
  /** Pinned under the body (actions). */
  footer?: ReactNode;
  children: ReactNode;
}

export default function PanelModal({ open = true, className = "", title, onClose, onKeyDownCapture, accent = "var(--yellow)", width = "max-w-2xl", headerExtra, toolbar, footer, children, dismissible = true, role, scrimStyle, "aria-describedby": describedBy }: PanelModalProps) {
  const { t } = useTranslation();
  const titleId = useId();

  return (
    <ModalLayer
      open={open}
      dismissible={dismissible}
      role={role}
      scrimStyle={scrimStyle}
      aria-describedby={describedBy}
      onClose={onClose}
      onKeyDownCapture={onKeyDownCapture}
      aria-labelledby={titleId}
      scrimClassName="p-6"
      className={`bg-panel border-2 border-black rounded-xl shadow-[4px_4px_0px_0px_rgba(0,0,0,1)] overflow-hidden w-full ${width} ${className} max-h-[80vh] flex flex-col`}
    >
      <PanelHeader
        title={title}
        accent={accent}
        titleId={titleId}
        actions={
          <>
            {headerExtra}
            <button type="button" onClick={onClose} disabled={!dismissible} aria-label={t("Close")} title={t("Close")} className="k-btn k-btn--text k-btn--text-primary">
              <X className="w-3.5 h-3.5" aria-hidden />
            </button>
          </>
        }
      />
      {toolbar && <div className="p-3 border-b-2 border-black/20">{toolbar}</div>}
      <div className="flex-1 min-h-0 overflow-y-auto slim-scrollbar">{children}</div>
      {footer && <div className="border-t-2 border-black/20 p-3 flex items-center justify-end gap-2">{footer}</div>}
    </ModalLayer>
  );
}
