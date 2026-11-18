import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { playlistAccessMessage } from "@lib/playlistAccess";
import { confirmAction } from "../../ui";
import { deletePlaylist as deletePlaylistRequest, putPlaylistTracks, renamePlaylist, type PlaylistDetail } from "../playlistApi";
import type { PlaylistTrack } from "../playlistTracks";

type Notify = (message: string) => void;

const announce = () => window.dispatchEvent(new CustomEvent("playlists-changed"));

/**
 * What the Playlists page changes about the open list: its songs (remove), its
 * name (inline rename) and its existence (delete). Each refreshes the grid and
 * tells the sidebar through `playlists-changed`.
 */
export function usePlaylistEditing({
  selectedPlaylist,
  selectedPlaylistName,
  setSelectedPlaylistName,
  playlistTracks,
  setPlaylistTracks,
  setSelectedPlaylist,
  loadPlaylists,
  showSuccess,
  showError,
}: {
  selectedPlaylist: PlaylistDetail | null;
  selectedPlaylistName: string | null;
  setSelectedPlaylistName?: (name: string | null) => void;
  playlistTracks: PlaylistTrack[];
  setPlaylistTracks: (tracks: PlaylistTrack[]) => void;
  setSelectedPlaylist: (playlist: PlaylistDetail | null) => void;
  loadPlaylists: () => Promise<void>;
  showSuccess: Notify;
  showError: Notify;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const currentName = useRef(selectedPlaylistName);
  currentName.current = selectedPlaylistName;

  // Cancel an in-progress rename when switching playlists.
  useEffect(() => {
    setRenaming(false);
  }, [selectedPlaylistName]);

  const repoint = (name: string | null) => {
    if (typeof setSelectedPlaylistName === "function") setSelectedPlaylistName(name);
  };

  const updatePlaylistTracks = async (tracks: PlaylistTrack[]) => {
    if (!selectedPlaylist || pending.current || tracks === playlistTracks) return false;
    const name = selectedPlaylist.name;
    const oldOrder = playlistTracks;
    pending.current = true;
    setSaving(true);
    setPlaylistTracks(tracks);
    let saved = false;
    try {
      const response = await putPlaylistTracks(name, tracks);
      if (!response.ok) {
        throw new Error(playlistAccessMessage(response.status) || t("The playlist couldn't be saved (HTTP {{status}}).", { status: response.status }));
      }
      saved = true;
      // A library refresh may have completed while the PUT was pending.
      if (currentName.current === name) setPlaylistTracks(tracks);
      await loadPlaylists();
      announce();
      return true;
    } catch (error) {
      if (!saved && currentName.current === name) setPlaylistTracks(oldOrder);
      showError(error instanceof Error ? error.message : t("The playlist couldn't be saved."));
      return saved;
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };

  const removeSongs = async (songs: PlaylistTrack[]) => {
    if (!selectedPlaylist || !songs?.length) return;
    const gone = new Set(songs.map((s) => s.path));
    await updatePlaylistTracks(playlistTracks.filter((track) => !gone.has(track.path)));
  };

  // Rename uses an inline editable title rather than window.prompt(), which
  // Tauri does not implement (it silently returns null in the renderer).
  const startRename = () => {
    if (!selectedPlaylist) return;
    setRenameValue(selectedPlaylist.name);
    setRenaming(true);
  };

  const submitRename = async () => {
    if (!selectedPlaylist) return;
    const current = selectedPlaylist.name;
    const newName = renameValue.trim();
    if (!newName || newName === current) {
      setRenaming(false);
      return;
    }
    try {
      const outcome = await renamePlaylist(current, newName);
      if (outcome.ok === false) {
        showError(outcome.denied);
        return;
      }
      setRenaming(false);
      showSuccess(t("Playlist renamed to \"{{name}}\"", { name: newName }));
      // Re-point the selection; the effect on selectedPlaylistName reloads the
      // detail view under the new name.
      repoint(newName);
      await loadPlaylists();
      announce();
    } catch (error) {
      console.error("Error renaming playlist:", error);
      showError(t("The playlist couldn't be renamed: {{reason}}", { reason: String(error) }));
    }
  };

  // Delete the whole playlist (not just selected tracks). Confirms first since
  // this is irreversible, then clears the view and refreshes the sidebar.
  const deletePlaylist = async () => {
    if (!selectedPlaylist) return;
    const name = selectedPlaylist.name;
    // `window.confirm` is a silent `false` under Tauri (see AlbumListPanel).
    const confirmed = await confirmAction({
      title: t("Delete the playlist \"{{name}}\"?", { name }),
      message: t("This action cannot be undone."),
      confirmLabel: t("Delete"),
      destructive: true,
    });
    if (!confirmed) return;
    try {
      const outcome = await deletePlaylistRequest(name);
      if (outcome.ok === false) {
        showError(outcome.denied);
        return;
      }
      showSuccess(t("Playlist \"{{name}}\" deleted", { name }));
      setSelectedPlaylist(null);
      setPlaylistTracks([]);
      repoint(null);
      await loadPlaylists();
      announce();
    } catch (error) {
      console.error("Error deleting playlist:", error);
      showError(t("The playlist couldn't be deleted: {{reason}}", { reason: String(error) }));
    }
  };

  return {
    removeSongs,
    updatePlaylistTracks,
    saving,
    renaming,
    renameValue,
    setRenameValue,
    startRename,
    submitRename,
    cancelRename: () => setRenaming(false),
    deletePlaylist,
  };
}
