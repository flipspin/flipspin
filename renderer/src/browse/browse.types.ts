import type { ApiData, ApiDataOr } from "../data";
import type { components } from "../api/generated/schema";

// Browse endpoints currently emit unknown. These fallback fields are checked by
// the guards in browseApi; ApiDataOr yields to generated models when available.
export type ProviderRef = { provider: string; id: string; url?: string | null };
export type BrowseTrack = components["schemas"]["AcquireTrack"] & {
  ref?: ProviderRef | null;
  albumRef?: ProviderRef | null;
  explicit?: boolean;
};
type Album = {
  ref: ProviderRef; title: string; artistName?: string | null;
  artistRef?: ProviderRef | null; coverUrl?: string | null;
  releaseDate?: string | null; recordType?: string | null;
  genres?: string[]; label?: string | null;
};
type Artist = { ref: ProviderRef; name: string; imageUrl?: string | null; albumCount?: number | null };
type Playlist = { ref: ProviderRef; title: string; pictureUrl?: string | null; owner?: string | null; description?: string | null; trackCount?: number | null };
type Genre = { ref: ProviderRef; name: string; imageUrl?: string | null };
export type AlbumData = ApiDataOr<"/api/browse/album/{provider}/{album_id}", "get", { album: Album; tracks: BrowseTrack[] }>;
export type ArtistData = ApiDataOr<"/api/browse/artist/{provider}/{artist_id}", "get", { artist: Artist; topTracks?: BrowseTrack[]; albums?: Album[]; related?: Artist[]; playlists?: Playlist[]; partial?: string[] }>;
export type PlaylistData = ApiDataOr<"/api/browse/playlist/{provider}/{playlist_id}", "get", { playlist: Playlist; tracks: BrowseTrack[] }>;
export type GenreData = ApiDataOr<"/api/browse/genre/{provider}/{genre_id}", "get", { genre: Genre; tracks?: BrowseTrack[]; albums?: Album[]; artists?: Artist[]; playlists?: Playlist[] }>;
export type SearchData = ApiDataOr<"/api/browse/search", "get", { query?: string; tracks?: BrowseTrack[]; albums?: Album[]; artists?: Artist[]; playlists?: Playlist[]; failed?: string[] }>;
export type OwnershipVerdict = NonNullable<ApiData<"/api/library/ownership", "post">["results"]>[number];
export type OwnedFile = NonNullable<OwnershipVerdict["match"]>;
export type ReplacementReceipt = ApiDataOr<"/api/browse/acquire", "post", { progress_id?: string; total: number; alreadyPresent?: unknown[]; linking?: string }>;
