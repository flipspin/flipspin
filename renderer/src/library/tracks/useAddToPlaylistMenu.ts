import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchPlaylist, putPlaylistTracks } from "../../playlists/playlistApi";
import { apiUrl } from "@lib/api";
import { fetchPlaylistSummaries } from "@lib/playlistSummaries";
import { playlistAccessMessage } from "@lib/playlistAccess";
import { playlistColor } from "../../playlists/playlistBadge";

/** Prefetch writable playlists so opening a submenu does not wait on the network.
 * Capture songs when the menu opens: outside mousedown clears Library selection before a menu action runs. */
export function useAddToPlaylistMenu({ showSuccess, showError, exclude = null }) {
  const { t } = useTranslation();
  const [playlists, setPlaylists] = useState(null);

  const refresh = useCallback(async (force = false) => {
    try {
      setPlaylists(await fetchPlaylistSummaries({ force }));
    } catch (error) {
      console.error(error);
      setPlaylists((current) => current ?? []);
    }
  }, []);

  useEffect(() => {
    refresh();
    const onChanged = () => refresh(true);
    window.addEventListener("playlists-changed", onChanged);
    return () => window.removeEventListener("playlists-changed", onChanged);
  }, [refresh]);

  const changed = () => window.dispatchEvent(new CustomEvent("playlists-changed"));

  const toRow = (s) => ({
    path: s.path,
    title: s.title || "Unknown Title",
    artist: s.artist || s.album?.artist || "Unknown Artist",
    album: (typeof s.album === "string" ? s.album : s.album?.album) || "Unknown Album",
    track_number: s.track_number,
    duration: s.duration,
    dateAdded: s.dateAdded,
  });

  const addTo = useCallback(
    async (name, songs) => {
      try {
        const outcome = await fetchPlaylist(name);
        const res = { ok: outcome.ok, status: outcome.ok ? 200 : 403 };
        if (!res.ok) {
          showError?.(playlistAccessMessage(res.status) || t("That playlist couldn't be opened."));
          return;
        }
        const current = outcome.ok ? outcome.data.tracks || [] : [];
        const have = new Set(current.map((x) => x.path));
        const fresh = songs.filter((s) => !have.has(s.path)).map(toRow);
        const duplicates = songs.length - fresh.length;
        if (fresh.length) {
          const saved = await putPlaylistTracks(name, [...current, ...fresh]);
          if (!saved.ok) {
            showError?.(playlistAccessMessage(saved.status) || t("The songs couldn't be added to the playlist."));
            return;
          }
        }
        const addedMsg = t("{{n}} songs added to \"{{name}}\".", { count: fresh.length, n: fresh.length, name });
        showSuccess?.(
          duplicates > 0
            ? `${addedMsg} ${t("{{n}} duplicates skipped.", { count: duplicates, n: duplicates })}`
            : addedMsg,
        );
        if (fresh.length) changed();
      } catch (error) {
        console.error(error);
        showError?.(t("The songs couldn't be added to the playlist."));
      }
    },
    [showSuccess, showError, t],
  );

  const createWith = useCallback(
    async (rawName, songs) => {
      const name = String(rawName || "").trim();
      if (!name) return;
      try {
        const res = await fetch(apiUrl("/api/playlists"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) {
          // 409 is a name collision, and names are one namespace for the whole
          // house; so it can collide with a list you cannot even see.
          showError?.(playlistAccessMessage(res.status) || t("The playlist couldn't be created."));
          return;
        }
        if (songs.length) {
          const saved = await fetch(apiUrl(`/api/playlists/${encodeURIComponent(name)}/tracks`), {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(songs.map(toRow)),
          });
          if (!saved.ok) {
            showError?.(playlistAccessMessage(saved.status) || t("The songs couldn't be added to the playlist."));
            changed();
            return;
          }
        }
        showSuccess?.(t("Playlist \"{{name}}\" created with {{n}} songs.", { count: songs.length, n: songs.length, name }));
        changed();
      } catch (error) {
        console.error(error);
        showError?.(t("The playlist couldn't be created."));
      }
    },
    [showSuccess, showError, t],
  );

  const submenu = (songs) => {
    const lists = (playlists || []).filter((p) => p.name !== exclude);
    return [
      { type: "input", placeholder: t("New playlist…"), onSubmit: (name) => createWith(name, songs) },
      { type: "separator" },
      ...(playlists === null
        ? [{ label: t("Loading…"), disabled: true }]
        : lists.length === 0
          ? [{ label: t("No playlists yet"), disabled: true }]
          : lists.map((p) => ({
              label: p.name,
              color: playlistColor(p.name),
              hint: String(p.trackCount ?? ""),
              onClick: () => addTo(p.name, songs),
            }))),
    ];
  };

  return { refresh, submenu };
}
