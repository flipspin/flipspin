/** Keep only album fields consumed by queued tracks so storage and window messages stay small.
 * Bare album-name strings pass through unchanged. */
import type { ApiData } from "../data/http";

type ListedAlbum = ApiData<"/api/listar-albums-con-metadata", "get">[number];
/** A queue projection also accepts album values persisted by older clients. */
type AlbumFields = Pick<ListedAlbum, "album" | "artist" | "path" | "cover">;
export type AlbumStub = { [Field in keyof AlbumFields]?: AlbumFields[Field] | null } & {
  name?: string;
  year?: ListedAlbum["year"] | string;
  genre?: ListedAlbum["genre"] | string[];
};

export function albumStub(album: object | string | null | undefined, cover?: string | null): AlbumStub | string | null {
  if (!album || typeof album !== "object") return album ?? null;
  const source = album as AlbumStub;
  return {
    album: source.album ?? source.name ?? null,
    name: source.name ?? undefined,
    artist: source.artist ?? null,
    path: source.path ?? null,
    year: source.year ?? null,
    genre: source.genre ?? null,
    cover: cover ?? source.cover ?? null,
  };
}

