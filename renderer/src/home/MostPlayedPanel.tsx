import { useSongMenu } from "../library/tracks/useSongMenu";
import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { Music } from "lucide-react";
import { useAudioPlayer } from "@state/AudioPlayerContext";
import { buildAlbumCoverUrl } from "@lib/api";
import { usePlayHistory } from "@lib/playHistory";
import CoverTile from "../ui/components/CoverTile";
import TrackContextMenu, { menuPointFrom } from "../albums/TrackContextMenu";
import { useAddToPlaylistMenu } from "../library/tracks/useAddToPlaylistMenu";
import { openLibraryAlbum } from "../browse/navigationStore";
import { useStatus } from "../state/useStatus";
import { decorate, type DecoratedTrack, type ListedAlbum } from "./decorateTrack";
import { SnapshotAge } from "../offline/SnapshotAge";
import { RowPanel, RowScroller, RowTile } from "./CoverRow";

// "Most played"; this device's most played songs (utils/playHistory.ts),
// joined against the album listing so a song that left the library drops out
// instead of showing a dead tile.
const LIMIT = 20;

type Entry = { song: DecoratedTrack; album: ListedAlbum; plays: number };
/** The slice of AudioPlayerContext (still untyped) this shelf calls. */
type PlayerApi = {
  play: (track: DecoratedTrack, opts?: { replaceQueue?: boolean; upcomingTracks?: DecoratedTrack[] }) => void;
  addToQueue: (tracks: DecoratedTrack[]) => void;
  addNextInQueue: (tracks: DecoratedTrack[]) => void;
  selectedTrack?: { path?: string } | null;
  isPlaying: boolean;
  setIsPlaying: (playing: boolean) => void;
};
type MenuState = { open: boolean; x: number; y: number; index: number };

export default function MostPlayedPanel({ albums = [], loaded = true, snapshotAt = null }: { albums?: ListedAlbum[]; loaded?: boolean; snapshotAt?: number | null }) {
  const { t } = useTranslation();
  const { play, addToQueue, addNextInQueue, selectedTrack, isPlaying, setIsPlaying } = useAudioPlayer() as unknown as PlayerApi;
  const { showSuccess, showError } = useStatus();
  const history = usePlayHistory();

  const top = useMemo((): Entry[] => {
    const ranked = Object.entries(history)
      .filter(([, h]) => h?.n > 0)
      .sort(([, a], [, b]) => b.n - a.n || (b.at || 0) - (a.at || 0));
    if (ranked.length === 0) return [];
    const byPath = new Map<string, ListedAlbum>();
    for (const album of albums) {
      for (const track of album?.tracks || []) {
        if (track?.path) byPath.set(track.path, album);
      }
    }
    const out: Entry[] = [];
    for (const [path, h] of ranked) {
      const album = byPath.get(path);
      const track = album?.tracks?.find((tr) => tr.path === path);
      if (track) out.push({ song: decorate(track, album), album, plays: h.n });
      if (out.length >= LIMIT) break;
    }
    return out;
  }, [history, albums]);

  // Play a song and let the rest of the shelf follow it.
  const playFrom = (index: number) => {
    const entry = top[index];
    if (!entry) return;
    play(entry.song, { replaceQueue: true, upcomingTracks: top.slice(index + 1).map((e) => e.song) });
  };

  const [menu, setMenu] = useState<MenuState>({ open: false, x: 0, y: 0, index: -1 });
  const playlistMenu = useAddToPlaylistMenu({ showSuccess, showError });
  const openMenu = (index: number) => (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ open: true, ...menuPointFrom(e), index });
    playlistMenu.refresh();
  };
  const closeMenu = useCallback(() => setMenu((m) => ({ ...m, open: false })), []);

  const entry = top[menu.index];
  const songs = entry ? [entry.song] : [];
  const songMenu = useSongMenu(songs, { showSuccess, showError });
  const items = entry ? songMenu.build({
    onPlay: () => playFrom(menu.index),
    onPlayNext: () => addNextInQueue(songs),
    onQueue: () => addToQueue(songs),
    playlistSubmenu: playlistMenu.submenu(songs),
  }) : [];

  return (
    <RowPanel title={t("Most played")} accent="var(--coral)" actions={<SnapshotAge at={snapshotAt} />}>
      <RowScroller icon={Music} loading={!loaded} empty={t("Nothing played yet.")}>
          {top.map(({ song, album, plays }, i) => {
            const title = (song.title || t("Song")).toString();
            return (
              <RowTile
                key={song.path}
                cover={<CoverTile src={album?.cover || buildAlbumCoverUrl(album)} label={album?.album || title} fontSize="32px" className="w-full h-full" />}
                title={title}
                subtitle={t("{{n}} plays", { count: plays, n: plays })}
                onOpen={() => openLibraryAlbum(album)}
                openLabel={t("Open the album of {{song}}", { song: title })}
                play={{
                  onPlay: () => playFrom(i),
                  current: selectedTrack?.path === song.path,
                  playing: isPlaying,
                  onToggle: () => setIsPlaying(!isPlaying),
                  seed: album?.album || title,
                }}
                onMenu={openMenu(i)}
                menuButton={false}
                menuOpen={menu.open && menu.index === i}
              />
            );
          })}
        </RowScroller>
      <TrackContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        title={entry?.song.title}
        artist={entry?.song.artist || ""}
        items={items}
        onClose={closeMenu}
      />
    </RowPanel>
  );
}
