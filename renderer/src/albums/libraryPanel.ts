/**
 * Pure helpers for the Library panel (AlbumListPanel): how a song is keyed
 * for this device's downloads, an album's playing order, and which album card
 * holds the song that is playing.
 */

type WithPath = { path: string };
type AlbumLike<T extends WithPath = WithPath> = { tracks?: T[] };

/**
 * The key a desktop download is filed under: the track's media path without
 * its query string. `url_path` can carry `?access_token=` (see
 * docs/API_COMPATIBILITY.md), so the query is always stripped.
 */
export function mediaPathOf(track: { url_path?: unknown } | null | undefined): string {
  return String(track?.url_path || "").split("?")[0];
}

/** The file name a download to this device suggests: the file's own, else the title. */
export function suggestedFileName(track: { path?: string | null; title?: unknown } | null | undefined): string {
  return String(track?.path || "").split(/[/\\]/).filter(Boolean).pop() || `${track?.title || "cancion"}.mp3`;
}

/** An album's songs by track number; songs without one go last, in listing order. */
export function albumTracksInOrder<T extends WithPath & { track_number?: unknown }>(album: AlbumLike<T> | null | undefined): T[] {
  return [...(album?.tracks || [])].sort(
    (a, b) => (Number(a.track_number) || Infinity) - (Number(b.track_number) || Infinity),
  );
}

/** Track path → id of the album that lists it. */
export function albumIdByPath<A extends AlbumLike>(albums: A[], albumIdOf: (album: A) => string): Map<string, string> {
  const m = new Map<string, string>();
  albums.forEach((a) => (a.tracks || []).forEach((tr) => m.set(tr.path, albumIdOf(a))));
  return m;
}

/** Albums narrowed to the songs that pass `keep`; albums left empty drop out. */
export function narrowAlbums<T extends WithPath, A extends { tracks: T[] }>(albums: A[], keep: (track: T) => boolean): A[] {
  return albums
    .map((album) => ({ ...album, tracks: album.tracks.filter(keep) }))
    .filter((album) => album.tracks.length > 0);
}
