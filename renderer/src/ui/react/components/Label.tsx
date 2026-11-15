/* krobi-ui; AGPL-3.0; see LICENSE. */
import type { LabelHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import { useFieldContext } from "./FieldContext";

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  required?: boolean;
  children: ReactNode;
}

/** a field label. wears `.z-label` (+ `--req` adds the asterisk). */
export function Label({ required, className, children, htmlFor, id, ...rest }: LabelProps) {
  const field = useFieldContext();
  const isRequired = required ?? field?.required;
  return (
    <label
      id={id ?? field?.labelId}
      htmlFor={htmlFor ?? field?.controlId}
      className={cx("z-label", isRequired && "z-label--req", className)}
      {...rest}
    >
      {children}
    </label>
  );
}
Label.displayName = "Label";
