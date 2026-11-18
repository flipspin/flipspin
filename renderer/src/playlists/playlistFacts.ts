import type { TFunction } from "i18next";
import i18n from "../i18n";
import { formatDuration } from "@lib/formatting";

/** Format duration in minutes below an hour and hours/minutes above it; omit zero duration.
 * Shared expectations live in contracts/playlist-page.json. */
export function playlistFacts(
  { songs, seconds, downloaded }: { songs: number; seconds: number; downloaded: number | null },
  t: TFunction = i18n.t.bind(i18n),
): string {
  const parts = [t("{{n}} songs", { count: songs, n: songs })];
  const total = Math.round(Number(seconds) || 0);
  if (total > 0) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    parts.push(h === 0 ? formatDuration(total) : m === 0 ? t("{{h}} h", { h }) : t("{{h}} h {{m}} min", { h, m }));
  }
  if (downloaded != null) parts.push(t("{{n}} downloaded", { count: downloaded, n: downloaded }));
  return parts.join(" · ");
}
