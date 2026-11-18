/* krobi-ui; AGPL-3.0; see LICENSE. */
import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";
import { mergeAriaIds, useFieldContext } from "./FieldContext";

export type InputSize = "sm" | "md" | "lg";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "prefix"> {
  size?: InputSize;
  /** leading addon (an icon, a unit). decorative unless it carries its own button. */
  prefix?: ReactNode;
  /** trailing addon. */
  suffix?: ReactNode;
  invalid?: boolean;
  /** mono digits (ids, amounts). */
  mono?: boolean;
}

/** a text field. wears `.z-input` (+ `--mono`); addon slots wear `.zr-input-wrap`. */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    size = "md",
    prefix,
    suffix,
    invalid,
    mono,
    className,
    id,
    required,
    "aria-describedby": describedBy,
    "aria-errormessage": errorMessage,
    "aria-invalid": ariaInvalid,
    ...rest
  },
  ref,
) {
  const field = useFieldContext();
  const isInvalid = ariaInvalid ?? invalid ?? field?.invalid;
  const input = (
    <input
      ref={ref}
      id={id ?? field?.controlId}
      className={cx("z-input", mono && "z-input--mono", className)}
      data-size={size !== "md" ? size : undefined}
      required={required ?? field?.required}
      aria-invalid={isInvalid || undefined}
      aria-describedby={mergeAriaIds(describedBy, field?.describedBy)}
      aria-errormessage={errorMessage ?? field?.errorId}
      {...rest}
    />
  );
  if (prefix == null && suffix == null) return input;
  return (
    <span className="zr-input-wrap" data-prefix={prefix != null || undefined} data-suffix={suffix != null || undefined}>
      {prefix != null && <span className="zr-input-wrap__addon zr-input-wrap__addon--start">{prefix}</span>}
      {input}
      {suffix != null && <span className="zr-input-wrap__addon zr-input-wrap__addon--end">{suffix}</span>}
    </span>
  );
});
Input.displayName = "Input";
