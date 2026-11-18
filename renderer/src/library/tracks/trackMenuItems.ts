import { isOfflineNow } from "../../offline/policy";
import i18n from "../../i18n";
import { IS_REMOTE_BACKEND } from "@lib/api";
import { openTrackFile } from "../../albums/AlbumTrackRow";
import type { MenuItem } from "../../albums/TrackContextMenu";
import { openTrackTags } from "./trackTagsStore";
import { SONG_ACTION_COLOR } from "./songActionColors";

type FileTrack = { path: string };

/** File actions consumed by the complete song menu. Translate at call time. */
export function trackFileItems<T extends FileTrack>({
  track,
  count: _count,
  onLyrics: _onLyrics,
  onEditTags = openTrackTags,
  paths = [track.path],
}: {
  track: T;
  /** Selection size, retained for existing callers. */
  count: number;
  /** Kept for callers; the lyric row moved into the Lyrics submenu. */
  onLyrics?: (track: T) => void;
  onEditTags?: (track: T) => void;
  paths?: string[];
}): MenuItem[] {
  const t = i18n.t.bind(i18n);
  const offline = isOfflineNow();
  return [
    { label: t("Edit tags"), disabled: offline, tooltip: offline ? t("Editing tags requires the nest") : undefined, color: SONG_ACTION_COLOR.tags, onClick: () => onEditTags(track) },
    {
      label: t("Open file"),
      color: SONG_ACTION_COLOR.openFile,
      disabled: IS_REMOTE_BACKEND,
      hint: IS_REMOTE_BACKEND ? t("Only if the nest is on this computer") : undefined,
      onClick: () => { paths.forEach(path => openTrackFile(path)); },
    },
  ];
}
