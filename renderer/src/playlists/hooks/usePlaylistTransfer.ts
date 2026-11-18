import type { ApiData } from "../../data";
import { useCallback } from "react";
import { apiUrl } from "@lib/api";
import i18n from "../../i18n";

// "Refresh" for a playlist imported from a source: fetch what is new there.
export function usePlaylistTransfer(
  selectedPlaylist: Pick<ApiData<"/api/playlists/{name}", "get">, "name" | "source_url"> | null,
  { showInfo, showSuccess, showError }: { showInfo: (message: string) => void; showSuccess: (message: string) => void; showError: (message: string) => void },
  loadPlaylistTracks: (name: string) => unknown,
) {
  const handleRefreshPlaylist = useCallback(async () => {
    if (!selectedPlaylist?.name || !selectedPlaylist?.source_url) {
      showError(i18n.t("This playlist has no source to refresh."));
      return;
    }
    showInfo(i18n.t("Looking for new songs…"));
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
        showSuccess(i18n.t("Downloading {{count}} new songs…", { count: data.added }));
      } else {
        showSuccess(data.message || i18n.t("Playlist updated"));
      }
      await loadPlaylistTracks(selectedPlaylist.name);
      if (data.added && data.added > 0) {
        setTimeout(() => {
          showSuccess(data.message || i18n.t("Added {{count}} new songs", { count: data.added }));
        }, 800);
      }
    } catch (error) {
      console.error(error);
      showError(i18n.t("Couldn't refresh: {{reason}}", { reason: error instanceof Error ? error.message : String(error) }));
    }
  }, [selectedPlaylist, loadPlaylistTracks, showInfo, showSuccess, showError]);

  return { handleRefreshPlaylist };
}
