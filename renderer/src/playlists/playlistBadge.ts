/**
 * The coloured-initials badge every playlist surface draws; the sidebar row,
 * the Home panel, and the grid the Playlists page shows when nothing is
 * selected. The colour hash and initials are `shared/cardArt.js`'s, the one
 * copy; this module only adds the playlist-shaped readers, so a playlist
 * paints the same colour everywhere.
 */
import { artColorFor, initials } from "../ui/components/cardArt";

export function playlistColor(name: string): string {
  return artColorFor(name);
}

/**
 * The text colour that reads on a playlist's colour: dark ink on the usual
 * mid-tone badges, cream on a very dark one. The badge colours are theme
 * variables (`var(--teal)`…) and five themes redefine them, so the real colour
 * is resolved from the page rather than assumed.
 */
export function playlistInk(name: string): string {
  const dark = "var(--dm-ink, var(--panel, #fffef7))";
  const light = "var(--dm-night, var(--ink, #151515))";
  if (typeof document === "undefined") return light;
  const probe = document.createElement("span");
  probe.style.display = "none";
  probe.style.background = playlistColor(name);
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).backgroundColor.match(/\d+(\.\d+)?/g)?.map(Number);
  probe.remove();
  if (!rgb || rgb.length < 3) return light;
  // Relative luminance (sRGB), the WCAG definition.
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  return luminance < 0.18 ? dark : light;
}

export function playlistInitials(name: string): string {
  return initials(name);
}

/** Only surface a count the backend actually gave; never invent one.
 *  `GET /api/playlists` serializes it as `trackCount`. */
export function playlistCount(p: unknown): number | null {
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const tracks = o.tracks;
  const n = o.trackCount ?? (Array.isArray(tracks) ? tracks.length : undefined) ?? o.count ?? o.track_count;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** The cover URLs a playlist row's tile is drawn from, in order. */
export function playlistCoverAlbums(p: unknown): string[] {
  if (!p || typeof p !== "object") return [];
  const list = (p as { coverAlbums?: unknown }).coverAlbums;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
}

export function playlistCover(p: unknown): string | null {
  if (!p || typeof p !== "object") return null;
  const c = (p as { cover?: unknown }).cover;
  return typeof c === "string" && c.length > 0 ? c : null;
}
