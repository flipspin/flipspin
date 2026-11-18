/* krobi-ui; AGPL-3.0; see LICENSE. */
import { useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type RefObject } from "react";
import { cx } from "./cx";
import { Portal } from "./Portal";
import { useDismissLayer } from "./useDismissLayer";
import { usePresence } from "./usePresence";

export type PopoverPlacement = "bottom-start" | "bottom-end";

export interface PopoverProps extends Omit<HTMLAttributes<HTMLDivElement>, "role" | "children"> {
  open: boolean;
  onClose: () => void;
  /** The button that opens it: positioned against, counted as inside, given focus back. */
  anchorRef: RefObject<HTMLElement | null>;
  placement?: PopoverPlacement;
  /** "dialog" for a panel of controls, "menu" for a list of actions. */
  role?: "dialog" | "menu";
  /** Where focus goes on open: the first control (default), the panel itself, or nowhere. */
  initialFocus?: "first" | "container" | "none";
  children: ReactNode;
}

const GAP = 6;
const PAD = 8;
const FOCUSABLE = 'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]:not([tabindex="-1"])';

/** Portal and clamp to the viewport so clipped or transformed ancestors cannot cut off the panel.
 * Join the dialog's modal branch and dismiss stack so only the innermost layer closes. */
export function Popover({
  open,
  onClose,
  anchorRef,
  placement = "bottom-end",
  role = "dialog",
  initialFocus = "first",
  className,
  style,
  children,
  ...rest
}: PopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const presence = usePresence(ref, open);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const closedBy = useRef<"escape" | "outside" | null>(null);

  useDismissLayer(ref, open, {
    onEscape: () => {
      closedBy.current = "escape";
      onClose();
    },
    onOutsidePress: () => {
      closedBy.current = "outside";
      onClose();
    },
    branches: [anchorRef],
  });

  // Place it, and keep it placed while it is up.
  useLayoutEffect(() => {
    if (!presence.mounted) return;
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const box = ref.current?.getBoundingClientRect();
      if (!anchor || !box) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const below = anchor.bottom + GAP;
      const top = below + box.height > vh - PAD && anchor.top - GAP - box.height >= PAD ? anchor.top - GAP - box.height : below;
      const wanted = placement === "bottom-end" ? anchor.right - box.width : anchor.left;
      const left = Math.max(PAD, Math.min(wanted, vw - box.width - PAD));
      setPos({ top: Math.max(PAD, top), left, maxHeight: vh - PAD * 2 });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [presence.mounted, anchorRef, placement]);

  // Focus in on open; back to the trigger on close. The return is decided in
  // the cleanup (where focus still is) but done in the next effect body:
  // React restores the pre-commit focus *after* cleanups, and the panel is
  // still mounted for its exit animation, so a focus() in the cleanup is undone.
  const giveBack = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      if (giveBack.current) anchorRef.current?.focus({ preventScroll: true });
      giveBack.current = false;
      return;
    }
    closedBy.current = null;
    const panel = ref.current;
    if (panel && initialFocus !== "none") {
      const target = initialFocus === "first" ? panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel : panel;
      target.focus({ preventScroll: true });
    }
    return () => {
      const active = document.activeElement;
      giveBack.current =
        closedBy.current !== "outside" && (!active || active === document.body || Boolean(panel?.contains(active)));
    };
  }, [open, initialFocus, anchorRef]);

  if (!presence.mounted) return null;
  return (
    <Portal>
      <div
        {...rest}
        ref={ref}
        role={role}
        tabIndex={-1}
        data-state={presence.state}
        className={cx("k-popover", className)}
        style={{ ...(pos ?? { top: 0, left: 0, visibility: "hidden" }), ...style }}
      >
        {children}
      </div>
    </Portal>
  );
}
Popover.displayName = "Popover";
