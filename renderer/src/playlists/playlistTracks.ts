import { albumStub } from "@lib/albumStub";
import { buildCoverImageUrl, buildMediaUrl, parseTrackPath } from "@lib/api";
import type { ListedAlbum, ListedTrack } from "../home/decorateTrack";

/**
 * What a playlist's songs need before they can be drawn or played. Playlist
 * JSON is thinner than the library listing: no `url_path`, no BPM/key, some
 * fields nested under `metadata`, and an album that may be a bare string; so
 * each track is joined back to the library's albums here. All pure.
 */

export interface PlaylistTrack extends ListedTrack {
  albumCover?: string | null;
  bpm?: number | null;
  key?: string | null;
  analysis?: unknown;
  dateAdded?: number | string | null;
  duration?: number | null;
  metadata?: { dateAdded?: number | string | null; duration?: number | null } | null;
}

export type LibraryAlbum = ListedAlbum;

const segments = (path: string | null | undefined) => (path || "").split(/[/\\]/);
const fileNameOf = (path: string | null | undefined) => segments(path).pop();
const objectAlbum = (track: PlaylistTrack): ListedAlbum | null =>
  track.album && typeof track.album === "object" ? track.album : null;

/** A track's cover: its album object's, else its own folder's cover.jpg. */
export function coverUrlFor(track: PlaylistTrack | null | undefined): string | null {
  if (!track) return null;
  const album = objectAlbum(track);
  if (album?.cover) return album.cover;
  const { albumName } = parseTrackPath(track.path);
  const albumFolder = albumName || String(track.album || "");
  return buildCoverImageUrl(albumFolder);
}

/** Each track with an `albumCover`, taken from the library album it belongs to when there is one. */
export function withCovers(tracks: PlaylistTrack[] = [], albums: LibraryAlbum[]): PlaylistTrack[] {
  return tracks.map((t) => {
    const albumName = String(t.album || "");
    const artistName = String(t.artist || "");
    const pathParts = (t.path || "").split(/[/\\]/).filter(Boolean);
    const folderName = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : "";

    const albumData = albums.find((a) => {
      const aName = String(a.album || "");
      const aArtist = String(a.artist || "");
      return (
        aName === albumName ||
        aName.toLowerCase() === albumName.toLowerCase() ||
        (folderName && aName.toLowerCase() === folderName.toLowerCase()) ||
        (artistName && aArtist && aArtist.toLowerCase() === artistName.toLowerCase())
      );
    });
    const cover = albumData?.cover || t.albumCover || coverUrlFor({ ...t, album: albumData });
    return { ...t, albumCover: cover || null };
  });
}

/** A playlist track ready for the player: a media URL from its path and an album stub. */
export function toQueueTrack(t: PlaylistTrack, albums: LibraryAlbum[]): PlaylistTrack {
  // The server's keys, not the last two segments: an import lands in
  // Music/<playlist>/<album>/, and its album key folds the playlist folder in.
  const { albumName, fileName } = parseTrackPath(t.path);
  const url_path = fileName && albumName ? buildMediaUrl(albumName, fileName) : t.url_path || undefined;

  const albumObj = objectAlbum(t);
  const trackAlbumStr = albumObj ? String(albumObj.album || albumObj.name || "") : String(t.album || "");

  const albumData = albums.find((a) => {
    const aAlbum = String(a.album || "");
    return (
      aAlbum === trackAlbumStr ||
      aAlbum.toLowerCase() === trackAlbumStr.toLowerCase() ||
      (albumName && aAlbum.toLowerCase() === albumName.toLowerCase())
    );
  });

  const existingCover = albumObj ? albumObj.cover : null;
  const cover = albumData?.cover || existingCover || t.albumCover || coverUrlFor(t);

  // A stub, never the library's album object; see `albumStub` in AlbumList:
  // the full object embeds every sibling track and made the queue ~5× bigger.
  return {
    ...t,
    path: t.path,
    url_path,
    album: albumData
      ? albumStub(albumData, albumData.cover || cover)
      : albumObj
        ? albumStub(albumObj, albumObj.cover || cover)
        : {
            album: (t.album as string) || "Unknown Album",
            artist: t.artist || "Unknown Artist",
            cover: cover || null,
          },
    albumCover: t.albumCover || cover || null,
  };
}

/**
 * Playlist JSON stores no BPM/key, so enrich each track from the matching
 * library track (by full path, falling back to filename).
 */
export function withLibraryMeta(playlistTracks: PlaylistTrack[], albums: LibraryAlbum[]): PlaylistTrack[] {
  const byPath = new Map<string, PlaylistTrack>();
  const byName = new Map<string, PlaylistTrack>();
  albums.forEach((a) =>
    ((a.tracks || []) as PlaylistTrack[]).forEach((t) => {
      if (t.path) byPath.set(t.path, t);
      const name = fileNameOf(t.path);
      if (name && !byName.has(name)) byName.set(name, t);
    }),
  );
  return playlistTracks.map((pt) => {
    const meta = byPath.get(pt.path) || byName.get(fileNameOf(pt.path));
    if (!meta) return pt;
    return {
      ...pt,
      bpm: pt.bpm ?? meta.bpm ?? null,
      key: pt.key ?? meta.key ?? null,
      bpmEstimated: pt.bpmEstimated ?? meta.bpmEstimated,
      bpmSource: pt.bpmSource ?? meta.bpmSource,
      bpmFixed: pt.bpmFixed ?? meta.bpmFixed,
      bpmConfidence: pt.bpmConfidence !== undefined ? pt.bpmConfidence : pt.bpm == null || pt.bpm === meta.bpm ? meta.bpmConfidence : null,
      keyConfidence: pt.keyConfidence !== undefined ? pt.keyConfidence : pt.key == null || pt.key === meta.key ? meta.keyConfidence : null,
      keyEstimated: pt.keyEstimated ?? meta.keyEstimated,
      keySource: pt.keySource ?? meta.keySource,
      keyFixed: pt.keyFixed ?? meta.keyFixed,
      analysis: pt.analysis ?? meta.analysis ?? null,
    };
  });
}

/** The tracks whose title, artist or album contains the query (case-insensitive). */
export function filterTracks(tracks: PlaylistTrack[], searchQuery: string): PlaylistTrack[] {
  const query = searchQuery.toLowerCase();
  if (!query) return tracks;
  return tracks.filter((track) => {
    const albumObj = objectAlbum(track);
    const titleStr = String(track.title || "").toLowerCase();
    const artistStr = String(track.artist || albumObj?.artist || "").toLowerCase();
    const albumStr = String(albumObj ? albumObj.album || albumObj.name || "" : track.album || "").toLowerCase();
    return titleStr.includes(query) || artistStr.includes(query) || albumStr.includes(query);
  });
}

export interface PlaylistRow {
  /** Flat, so the shared library row renders the same columns. */
  rowTrack: PlaylistTrack & { album: string; artist: string };
  albumName: string;
  artistName: string;
}

/**
 * Normalize a playlist track to the flat shape the shared library row draws
 * (playlist JSON nests some fields under `metadata`; the album may be an object
 * or missing, in which case its folder names it).
 */
export function toRow(track: PlaylistTrack): PlaylistRow {
  const albumObj = objectAlbum(track);
  const parts = segments(track.path);
  const albumFolder = parts.length >= 2 ? parts[parts.length - 2] : "";
  const albumName = (albumObj ? albumObj.album || albumObj.name || albumFolder : (track.album as string) || albumFolder) as string;
  const artistName =
    track.artist != null && String(track.artist).trim() !== ""
      ? String(track.artist).trim()
      : albumObj && albumObj.artist
        ? String(albumObj.artist).trim()
        : "";
  return {
    rowTrack: {
      ...track,
      album: albumName,
      artist: artistName,
      dateAdded: track.dateAdded ?? track.metadata?.dateAdded ?? null,
      duration: track.duration ?? track.metadata?.duration ?? null,
    },
    albumName,
    artistName,
  };
}
