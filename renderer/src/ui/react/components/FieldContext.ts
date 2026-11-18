/* krobi-ui; AGPL-3.0; see LICENSE. */
import { createContext, useContext } from "react";

export interface FieldContextValue {
  controlId: string;
  labelId?: string;
  describedBy?: string;
  errorId?: string;
  invalid?: boolean;
  required?: boolean;
}

export const FieldContext = createContext<FieldContextValue | null>(null);

export function useFieldContext() {
  return useContext(FieldContext);
}

export function mergeAriaIds(...values: Array<string | undefined>) {
  const ids = values.flatMap((value) => value?.split(/\s+/).filter(Boolean) ?? []);
  return ids.length ? [...new Set(ids)].join(" ") : undefined;
}
