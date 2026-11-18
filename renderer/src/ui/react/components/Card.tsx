/* krobi-ui; AGPL-3.0; see LICENSE. */
import { forwardRef, type HTMLAttributes, type MouseEvent, type ReactNode } from "react";
import { cx } from "./cx";

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** no offset shadow. */
  flat?: boolean;
  /** ink border. */
  ink?: boolean;
  /** dashed border, no shadow; an uncommitted thing. */
  idea?: boolean;
  /** styles the card as actionable; when `onClick` is present the title becomes the button. */
  interactive?: boolean;
  /** wrap children in `.z-card__body`. default true. */
  padded?: boolean;
  ariaLabel?: string;
  children?: ReactNode;
}

/** a raised surface with an optional head. wears `.z-card` (+ `--flat` `--ink` `--idea` `--interactive`). */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { title, subtitle, actions, flat, ink, idea, interactive, padded = true, onClick, ariaLabel, className, children, ...rest },
  ref,
) {
  const clickable = interactive || !!onClick;
  const hasHead = title != null || subtitle != null || actions != null;
  return (
    <div
      ref={ref}
      className={cx("z-card", flat && "z-card--flat", ink && "z-card--ink", idea && "z-card--idea", clickable && "z-card--interactive", className)}
      {...rest}
    >
      {hasHead && (
        <div className="zr-card__head">
          <div className="zr-card__titles">
            {title != null && onClick ? (
              <button
                type="button"
                className="zr-card__title zr-card__action"
                aria-label={ariaLabel}
                onClick={(event) => onClick(event as unknown as MouseEvent<HTMLDivElement>)}
              >
                {title}
              </button>
            ) : title != null ? (
              <div className="zr-card__title">{title}</div>
            ) : null}
            {subtitle != null && <div className="zr-card__sub">{subtitle}</div>}
          </div>
          {actions != null && <div className="zr-card__actions">{actions}</div>}
        </div>
      )}
      {padded ? <div className="z-card__body">{children}</div> : children}
    </div>
  );
});
Card.displayName = "Card";
