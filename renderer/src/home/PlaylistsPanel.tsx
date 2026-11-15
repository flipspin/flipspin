import type { StatusActions } from "../browse/cards.types";
import type { ApiData } from "../data";
import type { MenuItem } from "../albums/TrackContextMenu";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ListMusic } from "lucide-react";
import { useAudioPlayer } from "@state/AudioPlayerContext";
import { backendRequest, buildAlbumThumbUrl } from "@lib/api";
import { fetchPlaylistQueue } from "../playlists/playlistQueue";
import { useSnapshotReads } from "../offline/useOffline";
import { useConnection } from "../connection/connection";
import { fetchPlaylistSummaries } from "@lib/playlistSummaries";
import { playlistAccessMessage } from "@lib/playlistAccess";
import { CoverMosaic } from "../ui/components/CoverTile";
import TrackContextMenu, { menuPointFrom } from "../albums/TrackContextMenu";
import { playlistCount, playlistCover, playlistCoverAlbums } from "../playlists/playlistBadge";
import { useStatus } from "../state/useStatus";
import { confirmAction } from "../ui";
import { RowPanel, RowScroller, RowTile } from "./CoverRow";
import { songMenuItems, SONG_ACTION_COLOR } from "../library/tracks/songMenuItems";
import { useSongBpmMenu } from "../library/tracks/useSongBpmMenu";

// Fetch playlist tracks only for play, queue or menu actions; loading every list
// for its badge would add unnecessary requests. Share counts and covers with the playlist grid.

export default function PlaylistsPanel({ onOpen }: { onOpen?: (name: string) => void }) {
  const { t } = useTranslation();
  const { play, addToQueue, addNextInQueue, source, isPlaying, setIsPlaying } = useAudioPlayer();
  const { showSuccess, showError } = useStatus() as StatusActions;
  const [playlists, setPlaylists] = useState<ApiData<"/api/playlists", "get">>([]);
  const [loaded, setLoaded] = useState(false);
  const connection = useConnection();
  const snapshotReads = useSnapshotReads();
  const connected = connection.state === "connected" || snapshotReads;
  const [menu, setMenu] = useState<{ open: boolean; x: number; y: number; name: string | null }>({ open: false, x: 0, y: 0, name: null });

  // `connected` stays true across snapshot → live; refresh on that transition too.
  const load = useCallback((force = false) => {
    if (!connected) return;
    fetchPlaylistSummaries({ force })
      .then((items: ApiData<"/api/playlists", "get">) => { setPlaylists(items); setLoaded(true); })
      .catch(() => { /* keep previous list on error */ });
  }, [connected, connection.state, snapshotReads]);

  useEffect(() => { load(true); }, [load]);
  useEffect(() => {
    const handler = () => load(true);
    window.addEventListener("playlists-changed", handler);
    window.addEventListener("focus", handler);
    window.addEventListener("online", handler);
    return () => {
      window.removeEventListener("playlists-changed", handler);
      window.removeEventListener("focus", handler);
      window.removeEventListener("online", handler);
    };
  }, [load]);

  const fetchTracks = (name: string) => fetchPlaylistQueue(name, showError);

  const playPlaylist = async (name: string) => {
    const tracks = await fetchTracks(name);
    if (tracks.length === 0) return;
    const [first, ...rest] = tracks;
    play(first, { replaceQueue: true, upcomingTracks: rest, context: tracks, source: { kind: "playlist", name } });
  };

  const queuePlaylist = async (name: string, next: boolean) => {
    const tracks = await fetchTracks(name);
    if (tracks.length === 0) return;
    (next ? addNextInQueue : addToQueue)(tracks);
  };

  const deletePlaylist = async (name: string) => {
    // `window.confirm` is a silent `false` under Tauri (see AlbumListPanel).
    const confirmed = await confirmAction({
      title: t("Delete the playlist \"{{name}}\"?", { name }),
      message: t("This action cannot be undone."),
      confirmLabel: t("Delete"),
      destructive: true,
    });
    if (!confirmed) return;
    try {
      const response = await backendRequest(`/api/playlists/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (!response.ok) {
        showError(playlistAccessMessage(response.status) || t("The playlist couldn't be deleted: {{reason}}", { reason: `HTTP ${response.status}` }));
        return;
      }
      showSuccess(t("Playlist \"{{name}}\" deleted", { name }));
      window.dispatchEvent(new CustomEvent("playlists-changed"));
    } catch (error) {
      showError(t("The playlist couldn't be deleted: {{reason}}", { reason: String(error) }));
    }
  };

  const openMenu = (name: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ open: true, ...menuPointFrom(e), name });
  };
  const closeMenu = useCallback(() => setMenu((m) => ({ ...m, open: false })), []);

  const [menuTracks, setMenuTracks] = useState<{ name: string | null; tracks: Awaited<ReturnType<typeof fetchPlaylistQueue>> }>({ name: null, tracks: [] });
  useEffect(() => {
    if (!menu.open || !menu.name) return;
    let alive = true;
    void fetchPlaylistQueue(menu.name, showError).then(tracks => {
      if (alive) setMenuTracks({ name: menu.name, tracks });
    });
    return () => { alive = false; };
  }, [menu.open, menu.name, showError]);
  const menuName = menu.name;
  const menuCount = menuName ? playlistCount(playlists.find((p) => String(p?.name) === menuName)) : null;
  const empty = menuCount === 0;
  const bpmMenu = useSongBpmMenu();
  const menuItems: MenuItem[] = menuName
    ? [
        ...songMenuItems({
          bpmItems: bpmMenu(menuTracks.name === menu.name ? menuTracks.tracks : []),
          disabled: empty,
          onPlay: () => playPlaylist(menuName),
          onPlayNext: () => queuePlaylist(menuName, true),
          onQueue: () => queuePlaylist(menuName, false),
        }),
        { type: "separator" },
        { label: t("Open playlist"), color: "var(--purple)", onClick: () => onOpen?.(menuName) },
        { label: t("Delete playlist"), color: SONG_ACTION_COLOR.remove, danger: true, onClick: () => deletePlaylist(menuName) },
      ]
    : [];

  return (
    <RowPanel title={t("Your playlists")} accent="var(--purple)">
      <RowScroller icon={ListMusic} loading={!loaded} empty={t("No playlists yet.")}>
          {playlists.map((p, i) => {
            const name = (p?.name || t("Playlist")).toString();
            const count = playlistCount(p);
            // Playlist-level artwork (a Spotify import's) wins; otherwise the
            // first albums' covers by directory name, 2×2; the Playlists grid's tile.
            const own = playlistCover(p);
            const covers = own ? [own] : playlistCoverAlbums(p).map((dir, i) => buildAlbumThumbUrl(dir, p?.coverVersions?.[i], 300)).filter(Boolean);
            return (
              <RowTile
                key={`${name}-${i}`}
                cover={<CoverMosaic covers={covers} label={name} className="w-full h-full" />}
                title={name}
                subtitle={count != null ? t("{{n}} songs", { count, n: count }) : null}
                onOpen={() => onOpen?.(name)}
                openLabel={t("Open the playlist {{name}}", { name })}
                play={
                  count === 0
                    ? undefined
                    : {
                        onPlay: () => playPlaylist(name),
                        current: source?.kind === "playlist" && source.name === name,
                        playing: isPlaying,
                        onToggle: () => setIsPlaying(!isPlaying),
                        seed: name,
                      }
                }
                onMenu={openMenu(name)}
                menuOpen={menu.open && menuName === name}
              />
            );
          })}
        </RowScroller>
      <TrackContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        title={menuName || ""}
        artist={menuCount != null ? t("{{n}} songs", { count: menuCount, n: menuCount }) : ""}
        items={menuItems}
        onClose={closeMenu}
      />
    </RowPanel>
  );
}
