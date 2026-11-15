import type { ApiData } from "../../data";
import { useCallback } from "react";
import { apiUrl } from "@lib/api";

// "Refresh" for a playlist imported from a source: fetch what is new there.
// Sending songs to VLC lives in albums/hooks/useAlbumActions,
// shared with the Library.
export function usePlaylistTransfer(
  selectedPlaylist: Pick<ApiData<"/api/playlists/{name}", "get">, "name" | "source_url"> | null,
  { showInfo, showSuccess, showError }: { showInfo: (message: string) => void; showSuccess: (message: string) => void; showError: (message: string) => void },
  loadPlaylistTracks: (name: string) => unknown,
) {
  const handleRefreshPlaylist = useCallback(async () => {
    if (!selectedPlaylist?.name || !selectedPlaylist?.source_url) {
      showError("Esta playlist no tiene fuente para actualizar.");
      return;
    }
    showInfo("Buscando canciones nuevas...");
    try {
      const res = await fetch(apiUrl(`/api/refresh-playlist/${encodeURIComponent(selectedPlaylist.name)}`), {
        method: "POST",
      });
      const data: ApiData<"/api/refresh-playlist/{name}", "post"> = await res.json();
      const failure = "detail" in data && typeof data.detail === "string" ? data.detail : null;
      if (!res.ok || data.status === "error") {
        throw new Error(failure || data.message || `HTTP ${res.status}`);
      }
      if (data.added && data.added > 0) {
        showSuccess(`Descargando ${data.added} canciones nuevas...`);
      } else {
        showSuccess(data.message || "Playlist actualizada");
      }
      await loadPlaylistTracks(selectedPlaylist.name);
      if (data.added && data.added > 0) {
        setTimeout(() => {
          showSuccess(data.message || `Agregadas ${data.added} canciones nuevas`);
        }, 800);
      }
    } catch (error) {
      console.error(error);
      showError("No se pudo actualizar: " + (error instanceof Error ? error.message : String(error)));
    }
  }, [selectedPlaylist, loadPlaylistTracks, showInfo, showSuccess, showError]);

  return { handleRefreshPlaylist };
}
