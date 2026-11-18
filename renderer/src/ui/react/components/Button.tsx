/* krobi-ui; AGPL-3.0; see LICENSE. */
import { forwardRef, useEffect, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";
import { useKrobiUiStrings } from "./strings";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** in flight: shows `…`, sets aria-busy, disables. the truthful loading glyph, not a spinner. */
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
  truncate?: boolean;
  /** ink-filled "on" state (a toggled tool). */
  on?: boolean;
  type?: "button" | "submit" | "reset";
}

/** the button. wears `.z-btn` (+ `--coral` `--danger` `--ghost` `--sm` `--lg` `--wide` `--icon` `--on`); lift/press comes from the primitive. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    icon,
    iconRight,
    fullWidth = false,
    truncate = false,
    on = false,
    type = "button",
    disabled,
    onClick,
    onKeyDown,
    className,
    children,
    ...rest
  },
  ref,
) {
  const strings = useKrobiUiStrings();
  const iconOnly = children == null && (icon != null || iconRight != null);
  const hasAccessibleName = rest["aria-label"] != null || rest["aria-labelledby"] != null || rest.title != null;
  useEffect(() => {
    if (import.meta.env.DEV && iconOnly && !hasAccessibleName) {
      console.warn("KrobiUi Button: icon-only buttons need aria-label, aria-labelledby, or title.");
    }
  }, [hasAccessibleName, iconOnly]);
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-disabled={disabled || loading || undefined}
      aria-busy={loading || undefined}
      data-loading={loading || undefined}
      className={cx(
        "z-btn",
        variant !== "secondary" && `z-btn--${variant}`,
        size !== "md" && `z-btn--${size}`,
        fullWidth && "z-btn--wide",
        iconOnly && "z-btn--icon",
        on && "z-btn--on",
        className,
      )}
      onClick={(event) => {
        if (loading) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClick?.(event);
      }}
      onKeyDown={(event) => {
        if (loading && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onKeyDown?.(event);
      }}
      {...rest}
    >
      {loading ? (
        <>
          <span className="zr-btn__wait" aria-hidden="true">…</span>
          <span className="z-sr">{strings.loading}</span>
        </>
      ) : icon != null ? (
        <span className="zr-icon-slot">{icon}</span>
      ) : null}
      {children != null && <span className={cx(truncate && "zr-truncate")}>{children}</span>}
      {iconRight != null && !loading && <span className="zr-icon-slot">{iconRight}</span>}
    </button>
  );
});
Button.displayName = "Button";
