/* krobi-ui; AGPL-3.0; see LICENSE. */
import { useRef, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";
import { Portal } from "./Portal";
import { useBodyScrollLock } from "./useBodyScrollLock";
import { useDismissLayer } from "./useDismissLayer";
import { useFocusTrap, type FocusTrapOptions } from "./useFocusTrap";
import { usePresence } from "./usePresence";

export interface ModalLayerProps extends Omit<HTMLAttributes<HTMLDivElement>, "role" | "children"> {
  /** false plays the exit animation, then unmounts. A caller that unmounts the layer itself skips the exit. */
  open?: boolean;
  onClose: () => void;
  /** "alertdialog" for a confirmation of something that cannot be undone. */
  role?: "dialog" | "alertdialog";
  /** where focus lands: `[data-autofocus]` inside, else the first focusable (default), the panel, or a resolver. */
  initialFocus?: FocusTrapOptions["initialFocus"];
  /** a press on the scrim closes. default true. */
  closeOnBackdrop?: boolean;
  /** false while something irreversible is in flight: Escape and the scrim do nothing. default true. */
  dismissible?: boolean;
  /** the skin of the scrim (layout, colour). The layer adds `.k-scrim` for position and motion. */
  scrimClassName?: string;
  scrimStyle?: CSSProperties;
  children: ReactNode;
}

/** Portal outside transformed ancestors and join the shared focus and dismissal stack.
 * Keep background content inert until exit completes; reduced motion skips the animation. */
export function ModalLayer({
  open = true,
  onClose,
  role = "dialog",
  initialFocus = "first",
  closeOnBackdrop = true,
  dismissible = true,
  scrimClassName,
  scrimStyle,
  className,
  children,
  ...rest
}: ModalLayerProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const presence = usePresence(ref, open);

  useFocusTrap(ref, open, { initialFocus, modal: true });
  useDismissLayer(ref, open, {
    onEscape: dismissible ? onClose : undefined,
    onOutsidePress: dismissible && closeOnBackdrop ? onClose : undefined,
  });
  useBodyScrollLock(open);

  if (!presence.mounted) return null;
  return (
    <Portal modal>
      <div className={cx("k-scrim", scrimClassName)} style={scrimStyle} role="presentation" data-state={presence.state}>
        <div
          {...rest}
          ref={ref}
          role={role}
          aria-modal="true"
          tabIndex={-1}
          className={cx("k-panel", className)}
          data-state={presence.state}
        >
          {children}
        </div>
      </div>
    </Portal>
  );
}
ModalLayer.displayName = "ModalLayer";
