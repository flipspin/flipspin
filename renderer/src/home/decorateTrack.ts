import { albumStub } from "@lib/albumStub";
import { buildAlbumCoverUrl, buildCoverImageUrl, buildMediaUrl, parseTrackPath } from "@lib/api";

/** An album as the listing sends it; only the fields a queued track needs. */
export interface ListedAlbum {
  album?: string | null;
  name?: string;
  artist?: string | null;
  path?: string | null;
  mediaKey?: string;
  year?: string | number | null;
  genre?: string | string[] | null;
  cover?: string | null;
  tracks?: ListedTrack[];
}

export interface ListedTrack {
  path: string;
  title?: string;
  artist?: string;
  url_path?: string;
  relPath?: string;
  album?: ListedAlbum | string | null;
  [key: string]: unknown;
}

export type DecoratedTrack = ListedTrack & {
  album: ReturnType<typeof albumStub>;
  url_path: string | undefined;
};

/** Queue tracks carry an album stub: full album objects embed every track
 * and would inflate storage writes and player-window messages. */
export function decorate(track: ListedTrack, albumObj?: ListedAlbum | string | null): DecoratedTrack {
  const album = albumObj || track.album;
  const { albumName, fileName } = parseTrackPath(track.path);
  // The album's inline cover, then the track's own directory, then the
  // album's; never `album.album`, which is the display name and 404s for the
  // albums whose folder is called something else. See `albumDirName` in utils/api.ts.
  const objectAlbum = album && typeof album === "object" ? album : null;
  const cover = objectAlbum?.cover || buildCoverImageUrl(albumName) || buildAlbumCoverUrl(album);
  return {
    ...track,
    album: albumStub(album, cover),
    url_path: buildMediaUrl(albumName, fileName) || track.url_path || undefined,
  };
}
