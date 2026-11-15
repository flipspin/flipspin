import type { ApiData } from "../data";
import type { PlayerTrack } from "@state/AudioPlayerContext";
import { backendRequest, buildCoverImageUrl, buildMediaUrl, parseTrackPath } from "@lib/api";
import { playlistAccessMessage } from "@lib/playlistAccess";
import i18n from "../i18n";

// A playlist row carries only a server-side path; the media URL and the cover
// are rebuilt from it the way PlaylistView's `buildQueueTrack` does, with a
// stub album (the queue is persisted; never embed a whole album object).
export function queueTrack(track: PlayerTrack) {
  const { albumName, fileName } = parseTrackPath(track?.path);
  const cover = buildCoverImageUrl(albumName) || null;
  const albumTitle = typeof track?.album === "object" ? track.album?.album || "" : track?.album || "";
  return {
    ...track,
    url_path: (albumName && fileName ? buildMediaUrl(albumName, fileName) : track?.url_path) || undefined,
    album: { album: albumTitle, artist: track?.artist || "", cover },
    albumCover: cover,
  };
}

/** A playlist's tracks, ready for the queue; [] after reporting the failure through `showError`. */
export async function fetchPlaylistQueue(name: string, showError?: (message: string) => void) {
  const fail = (reason: string) => i18n.t("The playlist's songs couldn't be loaded: {{reason}}", { reason });
  try {
    const response = await backendRequest(`/api/playlists/${encodeURIComponent(name)}`);
    if (!response.ok) {
      showError?.(playlistAccessMessage(response.status) || fail(`HTTP ${response.status}`));
      return [];
    }
    const data: Partial<ApiData<"/api/playlists/{name}", "get">> = response.body ? JSON.parse(response.body) : {};
    return (Array.isArray(data?.tracks) ? data.tracks : []).filter((tr) => tr?.path).map(queueTrack);
  } catch (error) {
    showError?.(fail(String(error)));
    return [];
  }
}
