import { prepareSearchDocument, scoreSearchDocument, searchWords, type SearchDocument } from "../../search/match";
import { artistKey, primaryArtist } from "../../albums/artistMatch";
import type { ListedAlbum, ListedTrack } from "../../home/decorateTrack";
import type { PlaylistSummary } from "../../playlists/playlistApi";
import { createSearchHistory } from "../../browse/catalogSearchHistory";

export const LIBRARY_HISTORY_KEY = "krobi.recentLibrarySearches";
export const librarySearchHistory = createSearchHistory(LIBRARY_HISTORY_KEY, 1);
export type SearchSong = ListedTrack & { album: ListedAlbum };
type Artist = { name: string; albums: Set<ListedAlbum>; songs: number; coverAlbum: ListedAlbum };
type Entry<T> = { item: T; document: SearchDocument };
const entry = <T>(item: T, fields: Parameters<typeof prepareSearchDocument>[0]): Entry<T> => ({ item, document: prepareSearchDocument(fields) });

/** Prepare once when loaded library data changes, not for each keystroke. */
export function librarySearchIndex(albums: ListedAlbum[], playlists: PlaylistSummary[]) {
  const artists = new Map<string, Artist>();
  const songs: Entry<SearchSong>[] = [];
  for (const album of albums) {
    for (const track of album.tracks || []) {
      const song = { ...track, artist: track.artist || album.artist || "", album };
      songs.push(entry(song, { title: song.title, artist: song.artist, album: album.album }));
      const name = primaryArtist(song.artist);
      if (!name) continue;
      const key = artistKey(name);
      let artist = artists.get(key);
      if (!artist) { artist = { name, albums: new Set(), songs: 0, coverAlbum: album }; artists.set(key, artist); }
      artist.albums.add(album);
      artist.songs++;
    }
  }
  return {
    artists: [...artists.values()].map(artist => entry(artist, { title: artist.name })),
    songs,
    albums: albums.map(album => entry(album, { title: album.album || "", artist: album.artist || "" })),
    // The shell's summaries are already filtered to the current account's access.
    playlists: playlists.map(playlist => entry(playlist, { title: playlist.name })),
  };
}

export function searchLibrary(index: ReturnType<typeof librarySearchIndex>, query: string) {
  const words = searchWords(query);
  function ranked<T>(entries: Entry<T>[]): T[] {
    if (!words.length) return [];
    return entries.map((entry, order) => ({ ...entry, order, score: scoreSearchDocument(entry.document, words) }))
      .filter(entry => entry.score >= 0).sort((a, b) => b.score - a.score || a.order - b.order).map(entry => entry.item);
  }
  return { artists: ranked(index.artists), songs: ranked(index.songs), albums: ranked(index.albums), playlists: ranked(index.playlists) };
}
