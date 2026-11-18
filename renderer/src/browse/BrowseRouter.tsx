/**
 * Renders whatever is on top of the browse navigation stack.
 *
 * The single place `App.jsx` has to know about. It subscribes to the store
 * itself, so `App.jsx` gains one branch and no new state, no new provider, and
 * no change to the context-provider nesting order, which is load-bearing.
 *
 * Returns `null` when the stack is empty, which is the signal for `App.jsx` to
 * render its normal `activePage`.
 */
import type { LibraryAlbum } from "../albums/library.types";
import { pluginRoutes } from "../plugins";
import { useSyncExternalStore, type ComponentType } from "react";

import AlbumPage from "./AlbumPage";
import ArtistPage from "./ArtistPage";
import GenrePage from "./GenrePage";
import PlaylistPage from "./PlaylistPage";
import SearchPage from "./SearchPage";
import LegacyLibraryAlbumPage from "../albums/LibraryAlbumPage";
import LegacyLibraryArtistPage from "../albums/LibraryArtistPage";
import LegacyLibrarySearchPage from "../library/search/LibrarySearchPage";
import { currentRoute, getState, subscribe } from "./navigationStore";

// These legacy pages consume the same partial library rows as their callers.
const LibraryAlbumPage = LegacyLibraryAlbumPage as ComponentType<{ id: string; albums: LibraryAlbum[]; online: boolean }>;
const LibraryArtistPage = LegacyLibraryArtistPage as ComponentType<{ name: string; albums: LibraryAlbum[] }>;
const LibrarySearchPage = LegacyLibrarySearchPage as ComponentType<{ query: string; albums: LibraryAlbum[] }>;

export default function BrowseRouter({ albums = [], backendOnline = null }: { albums?: LibraryAlbum[]; backendOnline?: boolean | null }) {
  useSyncExternalStore(subscribe, getState);
  const route = currentRoute();
  if (!route) return null;

  // `key` forces a remount when the target changes, so navigating from one
  // album straight to another cannot show the previous album's tracklist while
  // the new one loads.
  const key = `${route.kind}:${route.provider || ""}:${route.id || route.query || ""}`;

  switch (route.kind) {
    case "library-search":
      return <LibrarySearchPage key="library-search" albums={albums} query={route.query!} />;
    case "album":
      return <AlbumPage key={key} provider={route.provider!} id={route.id!} />;
    case "artist":
      return <ArtistPage key={key} provider={route.provider!} id={route.id!} />;
    case "playlist":
      return <PlaylistPage key={key} provider={route.provider!} id={route.id!} />;
    case "genre":
      return <GenrePage key={key} provider={route.provider!} id={route.id!} />;
    case "search":
      return <SearchPage key="search" query={route.query!} initialDraft={route.draft} mode={route.mode || "full"} />;
    case "library-album":
      return <LibraryAlbumPage key={key} id={route.id!} albums={albums} online={backendOnline !== false} />;
    case "library-artist":
      return <LibraryArtistPage key={key} name={route.id!} albums={albums} />;
    default: {
      const pluginRoute = pluginRoutes[route.kind];
      return pluginRoute ? <pluginRoute.Component key={key} route={route} albums={albums} /> : null;
    }
  }
}
