import { matchSongMenuItems } from "../../match/matchMenu";
import { openMatch } from "../../match/matchStore";
import type { MatchSong } from "../../match/matchStore";
import { getState } from "@state/identityStore";
import { relPathOf } from "@state/userLibraryStore";
import { isOfflineNow } from "../../offline/policy";
import { pluginTrackMenuItems } from "../../plugins";
import { withRemoveActions } from "../../acquisition/removeActions";
import i18n from "../../i18n";
import type { MenuItem } from "../../albums/TrackContextMenu";
import { trackFileItems } from "./trackMenuItems";
import { SONG_ACTION_COLOR } from "./songActionColors";
export { SONG_ACTION_COLOR } from "./songActionColors";

export type SongMenuTrack = { path: string; relPath?: string; title?: string };
export type SongMenuAction = keyof typeof SONG_ACTION_COLOR;
export type SongMenuOptions = {
  songs?: SongMenuTrack[];
  /** Album menus use selection actions even when the album contains one song. */
  selection?: boolean;
  omit?: ReadonlySet<SongMenuAction>;
  matchSong?: MatchSong;
  onMatch?: () => void;
  onPlay?: () => void;
  onPlayNext?: () => void;
  onQueue?: () => void;
  playlistSubmenu?: MenuItem[];
  lyricsSubmenu?: MenuItem[];
  onOpenLyrics?: () => void;
  playlistLabel?: string;
  afterPlaylist?: MenuItem[];
  bpmItems?: MenuItem[];
  tagItems?: MenuItem[];
  onOpenAlbum?: () => void;
  onGoToArtist?: () => void;
  artistDisabled?: boolean;
  onDownload?: () => void;
  downloaded?: boolean;
  sendSubmenu?: MenuItem[];
  extras?: MenuItem[];
  removals?: MenuItem[];
  disabled?: boolean;
};

const colored = (items: MenuItem[], color: string): MenuItem[] => items.map(item => "label" in item ? { ...item, color } : item);

/** The complete song menu. Empty/omitted groups never leave dangling separators. */
export function songMenuItems({
  songs = [], selection = false, omit = new Set(), matchSong, onMatch,
  onPlay, onPlayNext, onQueue, disabled,
  playlistSubmenu, playlistLabel, afterPlaylist = [],
  lyricsSubmenu, onOpenLyrics, bpmItems = [], tagItems = [],
  onOpenAlbum, onGoToArtist, artistDisabled, onDownload, downloaded,
  sendSubmenu, extras = [], removals = [],
}: SongMenuOptions): MenuItem[] {
  const t = i18n.t.bind(i18n);
  const items: MenuItem[] = [];
  const group = (rows: MenuItem[]) => {
    if (!rows.length) return;
    if (items.length) items.push({ type: "separator" });
    items.push(...rows);
  };
  const row = (key: SongMenuAction, label: string, props: Omit<Extract<MenuItem, { label: string }>, "label" | "color">): MenuItem[] =>
    omit.has(key) ? [] : [{ label, color: SONG_ACTION_COLOR[key], ...props }];
  group([
    ...(onPlay ? row("play", t("Play"), { disabled, onClick: onPlay }) : []),
    ...(onPlayNext ? row("playNext", t("Play next"), { disabled, onClick: onPlayNext }) : []),
    ...(onQueue ? row("queue", t("Add to the queue"), { disabled, onClick: onQueue }) : []),
  ]);
  group([
    ...(playlistSubmenu ? row("playlist", playlistLabel ?? t("Add to playlist"), { submenu: playlistSubmenu }) : []),
    ...(!omit.has("move") ? colored(afterPlaylist, SONG_ACTION_COLOR.move) : []),
  ]);
  const open = onOpenLyrics ? row("lyrics", t("View lyrics"), { onClick: onOpenLyrics }) : [];
  const lyrics = [
    ...open,
    ...(open.length && lyricsSubmenu?.length ? [{ type: "separator" } as MenuItem] : []),
    ...colored(lyricsSubmenu ?? [], SONG_ACTION_COLOR.lyrics),
  ];
  group([
    ...(lyricsSubmenu || open.length ? row("lyrics", t("Lyrics_plural"), { submenu: lyrics }) : []),
    ...(!omit.has("bpm") ? colored(bpmItems, SONG_ACTION_COLOR.bpm) : []),
  ]);
  group([
    ...(onOpenAlbum ? row("openAlbum", t("Open album"), { onClick: onOpenAlbum }) : []),
    ...(onGoToArtist ? row("goToArtist", t("Go to artist"), { disabled: artistDisabled, onClick: onGoToArtist }) : []),
  ]);
  const single = songs.length === 1;
  const fileItems = songs[0] ? trackFileItems({ track: songs[0], count: songs.length, paths: songs.map(song => song.path) }) : [];
  let match: MenuItem[] = [];
  const matchSelection = songs.length > 1 || selection;
  if (onMatch || (matchSelection && songs.length && getState().me?.isOwner)) {
    match = row("match", t("Match on MusicBrainz…"), {
      disabled: isOfflineNow(),
      tooltip: isOfflineNow() ? t("MusicBrainz needs the nest") : undefined,
      onClick: onMatch ?? (() => openMatch({
        relPaths: [...new Set(songs.map(relPathOf).filter(Boolean))],
        title: single ? songs[0].title : undefined,
      })),
    });
  } else if (!matchSelection && (songs[0] || matchSong)) {
    match = matchSongMenuItems(songs[0] ?? matchSong!, songs.length || 1);
  }
  group([
    ...(onDownload ? row("download", downloaded ? t("Open download on this computer") : t("Download to this computer…"), { onClick: onDownload }) : []),
    ...(!omit.has("tags") ? colored(single ? fileItems.slice(0, 1) : tagItems, SONG_ACTION_COLOR.tags) : []),
    ...(!omit.has("match") ? colored(match, SONG_ACTION_COLOR.match) : []),
    ...(!omit.has("plugin") && songs[0] ? colored(pluginTrackMenuItems(songs[0], { count: songs.length }), SONG_ACTION_COLOR.plugin) : []),
    ...(!omit.has("openFile") && songs[0] ? fileItems.slice(1) : []),
  ]);
  group(sendSubmenu ? row("sendTo", t("Send to"), { submenu: sendSubmenu }) : []);
  group(extras);
  return withRemoveActions(items, colored(removals, SONG_ACTION_COLOR.remove));
}
