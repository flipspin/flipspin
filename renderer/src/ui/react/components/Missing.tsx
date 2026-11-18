/* krobi-ui; AGPL-3.0; see LICENSE. */
import { useTranslation } from "react-i18next";
import { MISSING, type MissingKind } from "./missingWords";
import "./missing.css";

export interface MissingProps {
  kind: MissingKind;
  /** Overrides the kind's default reason (shown in the tooltip and read by screen readers). */
  reason?: string;
  className?: string;
}

/**
 * A value that isn't there: a short muted word that names why ("No data",
 * "Unavailable", "Not checked"…), with the reason in a tooltip and in the
 * accessible text. Not a Tab stop; the word carries the meaning on its own.
 */
export function Missing(props: MissingProps) {
  const { t } = useTranslation();
  return renderMissing(props, t);
}

/** Tables already subscribe to language once; reuse that translator per cell. */
// eslint-disable-next-line react-refresh/only-export-components
export function renderMissing({ kind, reason, className }: MissingProps, t: (key: string) => string) {
  const entry = MISSING[kind];
  const why = reason ?? t(entry.reason);
  return (
    <span className={className ? `k-missing ${className}` : "k-missing"} title={why} data-kind={kind}>
      {t(entry.word)}
      <span className="k-sr-only">: {why}</span>
    </span>
  );
}
Missing.displayName = "Missing";
