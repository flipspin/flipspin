/* krobi-ui; AGPL-3.0; see LICENSE. */
import { useId, type ReactNode } from "react";
import { cx } from "./cx";
import { FieldContext } from "./FieldContext";
import { Label } from "./Label";

export interface FieldProps {
  label?: ReactNode;
  required?: boolean;
  helper?: ReactNode;
  /** replaces the helper; rendered in the mono `.z-err` box. */
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}

/** label + control + hint/error stack. wears `.z-field` `.z-label` `.z-hint` `.z-err`. */
export function Field({ label, required, helper, error, htmlFor, className, children }: FieldProps) {
  const generatedId = useId();
  const controlId = htmlFor ?? `${generatedId}-control`;
  const labelId = label != null ? `${generatedId}-label` : undefined;
  const helperId = helper != null && error == null ? `${generatedId}-hint` : undefined;
  const errorId = error != null ? `${generatedId}-error` : undefined;

  return (
    <FieldContext.Provider
      value={{
        controlId,
        labelId,
        describedBy: errorId ?? helperId,
        errorId,
        invalid: error != null,
        required,
      }}
    >
      <div className={cx("z-field", className)}>
        {label != null && (
          <Label id={labelId} required={required} htmlFor={controlId}>
            {label}
          </Label>
        )}
        {children}
        {error != null ? (
          <div id={errorId} className="z-err" role="alert">
            {error}
          </div>
        ) : helper != null ? (
          <div id={helperId} className="z-hint">
            {helper}
          </div>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}
Field.displayName = "Field";
