import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useOffline } from "../../offline/useOffline";
import { useConnection } from "../../connection/connection";
import { fetchPlaylist, fetchPlaylists, type PlaylistDetail, type PlaylistSummary } from "../playlistApi";
import { withCovers, type LibraryAlbum, type PlaylistTrack } from "../playlistTracks";

/**
 * Every playlist (the grid) and the one asked for (its detail and songs),
 * reloaded when the backend comes back, when the name changes, and when any
 * surface announces `playlists-changed`.
 */
export function usePlaylistData({
  albums,
  selectedPlaylistName,
  backendOnline,
}: {
  albums: LibraryAlbum[];
  selectedPlaylistName: string | null;
  backendOnline?: boolean | null;
}) {
  const { t } = useTranslation();
  const connection = useConnection();
  const offline = useOffline();
  const connected = connection.state === "connected" || offline;
  const [playlistsLoaded, setPlaylistsLoaded] = useState(false);
  const [playlists, setPlaylists] = useState<PlaylistSummary[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState<PlaylistDetail | null>(null);
  const [playlistTracks, setPlaylistTracks] = useState<PlaylistTrack[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const readVersion = useRef(0);

  const loadPlaylists = useCallback(async () => {
    if (!connected) return;
    try {
      setPlaylists(await fetchPlaylists());
      setPlaylistsLoaded(true);
      setErrorMessage(null);
    } catch (error) {
      console.error("Error loading playlists:", error);
      setErrorMessage(t("Playlists couldn't be loaded: {{reason}}", { reason: String(error) }));
    }
  }, [t, connected]);

  const enrich = useCallback((tracks: PlaylistTrack[] = []) => withCovers(tracks, albums), [albums]);
  const enrichCurrent = useRef(enrich);
  enrichCurrent.current = enrich;

  const loadPlaylistTracks = useCallback(async (playlistName: string, fresh = false) => {
    const version = ++readVersion.current;
    try {
      const outcome = await fetchPlaylist(playlistName, fresh);
      if (version !== readVersion.current) return;
      if (outcome.ok === false) {
        setPlaylistTracks([]);
        setSelectedPlaylist(null);
        setErrorMessage(outcome.denied);
        return;
      }
      const data = outcome.data;
      setPlaylistTracks(enrichCurrent.current(data.tracks || []));
      setSelectedPlaylist(data);
      setLoadedFor(playlistName);
      setErrorMessage(null);
    } catch (error) {
      if (version !== readVersion.current) return;
      console.error("Error loading playlist tracks:", error);
      setErrorMessage(t("The playlist's songs couldn't be loaded: {{reason}}", { reason: String(error) }));
    }
  }, [t]);

  useEffect(() => {
    loadPlaylists();
  }, [loadPlaylists]);

  // The grid lists what the sidebar drawer creates and what this page deletes;
  // both announce it on the same window event the sidebar listens for.
  useEffect(() => {
    const handler = (event: Event) => {
      void loadPlaylists();
      const { names, playlists: refreshed } = (event as CustomEvent<{ names?: string[]; playlists?: PlaylistDetail[] }>).detail ?? {};
      if (selectedPlaylistName && (!names || names.includes(selectedPlaylistName))) {
        const data = refreshed?.find(playlist => playlist.name === selectedPlaylistName);
        if (data) {
          ++readVersion.current;
          setPlaylistTracks(enrich(data.tracks || []));
          setSelectedPlaylist(data);
          setLoadedFor(selectedPlaylistName);
          setErrorMessage(null);
        } else {
          void loadPlaylistTracks(selectedPlaylistName, !!names);
        }
      }
    };
    window.addEventListener("playlists-changed", handler);
    return () => window.removeEventListener("playlists-changed", handler);
  }, [loadPlaylists, loadPlaylistTracks, selectedPlaylistName, enrich]);

  useEffect(() => {
    if (!connected || (backendOnline === false && !offline)) return;
    if (selectedPlaylistName) {
      loadPlaylistTracks(selectedPlaylistName);
    } else {
      ++readVersion.current;
      setSelectedPlaylist(null);
      setPlaylistTracks([]);
    }
  }, [connected, offline, backendOnline, selectedPlaylistName, loadPlaylistTracks]);

  useEffect(() => {
    if (albums.length > 0 && playlistTracks.length > 0) {
      setPlaylistTracks((prev) => enrich(prev));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- enrich on album load only; re-running on playlistTracks would re-enrich repeatedly
  }, [albums, enrich]);

  return {
    playlists,
    playlistsLoaded,
    loadedFor,
    selectedPlaylist,
    setSelectedPlaylist,
    playlistTracks,
    setPlaylistTracks,
    errorMessage,
    loadPlaylists,
    loadPlaylistTracks,
  };
}
