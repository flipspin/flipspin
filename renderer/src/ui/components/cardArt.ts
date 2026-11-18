/** Keep pure card helpers separate from components for React refresh.
 * Share fallback art across card surfaces so identical items look consistent. */

// Bounded accent set, shared with the sidebar and the home panels so a browse
// page reads as part of Flipspin rather than as a new palette. Tokens only: five
// themes redefine every colour, so a hardcoded hex is right in exactly one.
export const ART_COLORS = [
  "var(--coral)",
  "var(--teal)",
  "var(--yellow)",
  "var(--blue)",
  "var(--purple)",
  "var(--green)",
];

export function hashOf(text: unknown) {
  let h = 0;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** A stable colour for a name, so the same album is always the same tile. */
export function artColorFor(name: unknown) {
  return ART_COLORS[hashOf(name) % ART_COLORS.length];
}

export function initials(name: unknown) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || parts[0]?.[1] || "")).toUpperCase() || "♪";
}

/** Open provider attribution links in the OS browser. */
export function openExternal(url: string | null | undefined) {
  if (!url) return;
  const openViaMain = typeof window !== "undefined" ? window.desktopAPI?.openExternal : null;
  if (typeof openViaMain === "function") {
    Promise.resolve(openViaMain(url)).catch(() =>
      window.open(url, "_blank", "noopener,noreferrer"),
    );
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * mm:ss, or h:mm:ss past an hour. Durations are seconds in every browse payload.
 *
 * The hour case is not cosmetic: a 50-track playlist totals ~163 minutes, and
 * "163:08" reads as a track length rather than a running time.
 */
export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return "";
  const total = Math.round(seconds);
  const s = String(total % 60).padStart(2, "0");
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}:${s}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${s}`;
}
