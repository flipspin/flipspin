import { useLyricsMenu } from "../../lyrics/useLyricsMenu";
import { lyricsKeyOf, openLyrics } from "../../lyrics/lyricsStore";
import { useRemoveActions } from "../../acquisition/removeActions";
import { useDeviceDownloads } from "../../albums/hooks/useDeviceDownloads";
import { openLibraryAlbum, openLibraryArtist } from "../../browse/navigationStore";
import { primaryArtist } from "../../albums/artistMatch";
import { vlcMenuItems } from "../../vlc/vlcSend";
import { useSongBpmMenu, type BpmSong } from "./useSongBpmMenu";
import { useBulkTagMenu } from "./useBulkTagMenu";
import { songMenuItems, type SongMenuOptions, type SongMenuTrack } from "./songMenuItems";

type Song = SongMenuTrack & BpmSong & {
  artist?: string | null;
  album?: string | { artist?: string | null; album?: string | null } | null;
  url_path?: unknown;
};
type Options = {
  showSuccess?: (message: string) => void;
  showError?: (message: string) => void;
  onChanged?: () => void;
};
const noop = () => {};

/** Shared capabilities; surfaces supply playback, playlist context and declared omissions. */
export function useSongMenu(songs: Song[], { showSuccess, showError, onChanged = noop }: Options = {}) {
  const lyricsSubmenu = useLyricsMenu(songs, onChanged, showError ?? noop);
  const bpm = useSongBpmMenu();
  const tags = useBulkTagMenu();
  const removals = useRemoveActions(songs, onChanged);
  const downloads = useDeviceDownloads({ showSuccess, showError });
  const single = songs.length === 1 ? songs[0] : null;
  const artist = single?.artist || (typeof single?.album === "object" ? single.album?.artist : "");
  return {
    ...downloads,
    build: (options: SongMenuOptions) => songMenuItems({
      songs,
      lyricsSubmenu,
      bpmItems: bpm(songs),
      tagItems: tags(songs),
      removals,
      onOpenLyrics: single ? () => { const key = lyricsKeyOf(single); if (key) openLyrics(key); } : undefined,
      onOpenAlbum: single ? () => openLibraryAlbum({ path: single.path, album: single.album }) : undefined,
      onGoToArtist: single ? () => openLibraryArtist(primaryArtist(artist)) : undefined,
      artistDisabled: !artist,
      downloaded: songs.length > 0 && songs.every(downloads.isDownloaded),
      onDownload: async () => { for (const song of songs) await downloads.downloadToThisDevice(song); },
      sendSubmenu: vlcMenuItems(songs, ""),
      ...options,
    }),
  };
}
