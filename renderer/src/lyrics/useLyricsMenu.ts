import { useEffect } from "react";
import { isApiError } from "../data";
import i18n from "../i18n";
import type { MenuItem } from "../albums/TrackContextMenu";
import { lyricsKeyOf, startScan, useLyricsJobs, watchJobs, type LyricsEngine } from "./lyricsStore";
import { refreshLyricStates } from "./lyricStates";

type Song = { path?: string | null; relPath?: string | null };
export function lyricsMenuItems(songs: Song[], _engine: LyricsEngine | undefined, clear: () => void, onError: (message: string) => void): MenuItem[] {
  const t = i18n.t.bind(i18n);
  const run = async () => {
    const paths = [...new Set(songs.map(lyricsKeyOf).filter((p): p is string => Boolean(p)))];
    if (!paths.length) return;
    try {
      await startScan(paths);
    } catch (error) {
      onError(isApiError(error) && error.status === 409
        ? t("A lyrics search is already running")
        : t("Could not start the lyrics job. Try again."));
      return;
    }
    clear();
    void refreshLyricStates().catch(() => onError(t("The job started; lyric states could not be refreshed.")));
  };
  return [
    { label: t("Search the catalogs"), color: "var(--teal)", onClick: () => { void run(); } },
  ];
}
export function useLyricsMenu(songs: Song[], clear: () => void, onError: (message: string) => void) {
  const jobs = useLyricsJobs();
  const active = songs.length > 0;
  useEffect(() => active ? watchJobs() : undefined, [active]);
  return lyricsMenuItems(songs, jobs?.engine, clear, onError);
}
