/** Use runtime theme tokens and explicit button geometry so global button defaults cannot override this surface. */

import type { CSSProperties } from "react";
import { msg } from "../i18n";

/** Surface card: paper, ink hairline, the 3px "pop" shadow. */
export const cardStyle: CSSProperties = {
  background: "var(--panel)",
  border: "2px solid var(--line)",
  borderRadius: "var(--r-md)",
  boxShadow: "var(--shadow-pop-sm)",
  color: "var(--ink)",
};

export const monoStyle: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--ink-3)",
};

/**
 * Primary / secondary / danger button.
 * @param {"primary"|"secondary"|"ghost"} variant
 * @param {boolean} disabled
 */
export function buttonStyle(variant: "primary" | "secondary" | "ghost" = "secondary", disabled = false): CSSProperties {
  const backgrounds = {
    primary: "var(--coral)",
    secondary: "var(--panel)",
    ghost: "var(--paper-2)",
  };
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    minHeight: 0,
    padding: "8px 14px",
    fontFamily: "var(--font-main)",
    fontSize: 13,
    fontWeight: 700,
    color: "var(--ink)",
    background: backgrounds[variant] || backgrounds.secondary,
    border: "2px solid var(--line)",
    borderRadius: "var(--r-sm)",
    boxShadow: disabled ? "none" : "var(--shadow-pop-sm)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    transition: "opacity .12s ease, box-shadow .08s ease",
  };
}

/** Small rounded label (counts, ids, reasons). */
export function chipStyle({ bg = "var(--paper-2)", fg = "var(--ink-2)", mono = false }: { bg?: string; fg?: string; mono?: boolean } = {}): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "2px 8px",
    borderRadius: 999,
    border: "1.5px solid var(--line)",
    background: bg,
    color: fg,
    fontFamily: mono ? "var(--font-mono)" : "var(--font-main)",
    fontSize: 11,
    fontWeight: 600,
    lineHeight: 1.6,
  };
}

/**
 * The palette for each confidence bucket. Tints read as "state" without
 * shouting, and the paired `fg` token keeps text legible on that tint in every
 * theme.
 */
export const CONFIDENCE_STYLES = {
  strong: {
    label: msg("Certain"),
    accent: "var(--green)",
    tint: "var(--green-tint)",
    fg: "var(--fg-green)",
    hint: msg("Certain matches. Already selected."),
  },
  review: {
    label: msg("To review"),
    accent: "var(--yellow)",
    tint: "var(--yellow-tint)",
    fg: "var(--fg-yellow)",
    hint: msg("{{app}} found something, but isn't sure it's the same recording."),
  },
  rejected: {
    label: msg("Rejected"),
    accent: "var(--rose)",
    tint: "var(--rose-tint)",
    fg: "var(--fg-rose)",
    hint: msg("Not similar enough. Select them only if you know they're right."),
  },
};

export function confidenceStyle(confidence: string) {
  return CONFIDENCE_STYLES[confidence as keyof typeof CONFIDENCE_STYLES] || CONFIDENCE_STYLES.rejected;
}

/** "3:52" from a duration in seconds; empty when the provider didn't give one. */
export function formatDuration(seconds: number | null | undefined) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "1 h 12 min" / "4 min 05 s"; for elapsed time and estimates. */
export function formatElapsed(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min ${String(s).padStart(2, "0")} s`;
  return `${s} s`;
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
