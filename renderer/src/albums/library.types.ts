import type { LibraryAlbums } from "../data";
import type { ListedAlbum } from "../home/decorateTrack";

// UI callers also pass album stubs, legacy persisted dates, and partially
// loaded rows. Server fields come from the generated album listing.
export type LibraryTrack = Partial<Omit<LibraryAlbums[number]["tracks"][number], "dateAdded" | "keySource" | "bpmSource" | "analysisState" | "analysis">> & {
  path: string;
  album?: LibraryAlbum | string | null;
  dateAdded?: number | string | null;
  keySource?: string | null;
  bpmSource?: string | null;
  analysisState?: string;
  analysis?: unknown;
};
export type LibraryAlbum = Partial<Omit<LibraryAlbums[number], "tracks" | "year" | "genre">> & Pick<ListedAlbum, "name" | "year" | "genre"> & {
  dateAdded?: number;
  tracks?: LibraryTrack[];
};
