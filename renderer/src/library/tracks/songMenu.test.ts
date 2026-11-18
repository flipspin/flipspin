import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "../../i18n";
import type { MenuItem } from "../../albums/TrackContextMenu";
import { songMenuItems, SONG_ACTION_COLOR, type SongMenuOptions } from "./songMenuItems";
import { closeMatch, useMatchScope } from "../../match/matchStore";
import { act, renderHook } from "@testing-library/react";

const openFile = vi.hoisted(() => vi.fn());
vi.mock("../../albums/AlbumTrackRow", () => ({ openTrackFile: openFile }));

const state = vi.hoisted(() => ({ remote: true, owner: true, offline: false }));
vi.mock("@lib/api", async original => ({ ...await original<typeof import("@lib/api")>(), get IS_REMOTE_BACKEND() { return state.remote; } }));
vi.mock("@state/identityStore", async original => ({ ...await original<typeof import("@state/identityStore")>(), getState: () => ({ me: { isOwner: state.owner } }) }));
vi.mock("../../offline/policy", () => ({ isOfflineNow: () => state.offline }));
vi.mock("../../plugins", () => ({ pluginTrackMenuItems: () => [{ label: "Plugin action", onClick: vi.fn() }] }));

const songs = [
  { path: "/music/Album/one.mp3", relPath: "Album/one.mp3", title: "One" },
  { path: "/music/Album/two.mp3", relPath: "Album/two.mp3", title: "Two" },
];
const labels = (items: MenuItem[]) => items.map(item => "label" in item ? item.label : item.type);
const action = (label: string): MenuItem => ({ label, onClick: vi.fn() });
const base: SongMenuOptions = {
  songs: [songs[0]],
  onPlay: vi.fn(), onPlayNext: vi.fn(), onQueue: vi.fn(),
  playlistSubmenu: [], lyricsSubmenu: [action("Search the catalogs")], onOpenLyrics: vi.fn(),
  bpmItems: [action("Double BPM"), action("Halve BPM")],
  onOpenAlbum: vi.fn(), onGoToArtist: vi.fn(), onDownload: vi.fn(),
  removals: [action("Remove download"), action("Remove from my library"), { type: "separator" }, { label: "Delete file from nest…", danger: true, onClick: vi.fn() }],
};
const order = [
  "Play", "Play next", "Add to the queue", "separator",
  "Add to playlist", "separator",
  "Lyrics_plural", "Double BPM", "Halve BPM", "separator",
  "Open album", "Go to artist", "separator",
  "Download to this computer…", "Edit tags", "Match on MusicBrainz…", "Plugin action", "Open file", "separator",
  "Remove download", "Remove from my library", "separator", "Delete file from nest…",
];
const surfaces: [string, SongMenuOptions, string[]][] = [
  ["Library list", {}, []],
  ["Album page", { omit: new Set(["openAlbum"]) }, ["Open album"]],
  ["Artist page", { omit: new Set(["goToArtist"]) }, ["Go to artist"]],
  ["Playlist", { playlistLabel: "Add to another playlist", afterPlaylist: [action("Move")], extras: [action("Remove from playlist")] }, []],
  ["Search", {}, []],
  ["Home recent", { extras: [action("Play the album"), action("Choose another song…"), action("Move to the front"), action("Remove from Home")] }, []],
  ["Home most played", {}, []],
  ["Player cover", { omit: new Set(["play", "playNext", "queue"]) }, ["Play", "Play next", "Add to the queue"]],
  ["Explore library row", {}, []],
  ["Library album card", { songs, selection: true, onOpenLyrics: undefined, tagItems: [action("Edit tags")] }, []],
  ["Artist album card", { songs, selection: true, omit: new Set(["goToArtist"]), onOpenLyrics: undefined, tagItems: [action("Edit tags")] }, ["Go to artist"]],
  ["Album header", { songs, selection: true, omit: new Set(["openAlbum"]), onOpenLyrics: undefined, tagItems: [action("Edit tags")], onMatch: vi.fn() }, ["Open album"]],
];

// Translation happens at call time, as in each screen; leave the suite's Spanish default intact.
const english = (values: string[]) => values.map(value => value === "Lyrics_plural" ? "Lyrics" : value);
afterEach(() => { state.remote = true; state.owner = true; state.offline = false; openFile.mockClear(); closeMatch(); });

describe("one complete menu on every song surface", () => {
  it.each(surfaces)("orders %s and keeps remote Open file visible", async (_surface, options, omitted) => {
    await i18n.changeLanguage("en");
    try {
      const menu = songMenuItems({ ...base, ...options });
      let expected = order.filter(label => !omitted.includes(label));
      if (options.playlistLabel) expected = expected.flatMap(label => label === "Add to playlist" ? ["Add to another playlist", "Move"] : [label]);
      if (options.extras) {
        const at = expected.indexOf("Remove download");
        expected.splice(at, 0, ...labels(options.extras), "separator");
      }
      // Omitted first group leaves no leading rule.
      if (expected[0] === "separator") expected.shift();
      expect(labels(menu)).toEqual(english(expected));
      expect(menu.find(item => "label" in item && item.label === "Open file")).toMatchObject({ disabled: true, hint: "Only if the nest is on this computer", color: SONG_ACTION_COLOR.openFile });
      expect(menu.every((item, index) => item.type !== "separator" || (index > 0 && index < menu.length - 1 && menu[index - 1].type !== "separator"))).toBe(true);
      const lyrics = menu.find(item => "label" in item && item.label === "Lyrics");
      expect(lyrics && "submenu" in lyrics ? labels(lyrics.submenu ?? []) : []).toEqual(options.selection ? ["Search the catalogs"] : ["View lyrics", "separator", "Search the catalogs"]);
      expect(menu.filter(item => "label" in item && item.label === "Edit tags")).toHaveLength(1);
      expect(menu.filter(item => "label" in item && item.label === "Match on MusicBrainz…")).toHaveLength(1);
    } finally { await i18n.changeLanguage("es"); }
  });

  it("uses the same colors and actions for downloads, tags, matching and plugins", async () => {
    await i18n.changeLanguage("en");
    try {
      const menu = songMenuItems({ ...base, downloaded: true });
      for (const [label, color] of [["Open download on this computer", SONG_ACTION_COLOR.download], ["Edit tags", SONG_ACTION_COLOR.tags], ["Match on MusicBrainz…", SONG_ACTION_COLOR.match], ["Plugin action", SONG_ACTION_COLOR.plugin], ["Lyrics", SONG_ACTION_COLOR.lyrics], ["Double BPM", SONG_ACTION_COLOR.bpm]]) {
        expect(menu.find(item => "label" in item && item.label === label)).toMatchObject({ color });
      }
      const download = menu.find(item => "label" in item && item.label === "Open download on this computer");
      if (download && "onClick" in download) download.onClick?.();
      expect(base.onDownload).toHaveBeenCalledOnce();
    } finally { await i18n.changeLanguage("es"); }
  });

  it("opens every selected file for a local nest", () => {
    state.remote = false;
    const menu = songMenuItems({ ...base, songs });
    const file = menu.find(item => "label" in item && item.label === i18n.t("Open file"));
    expect(file).toMatchObject({ disabled: false, hint: undefined });
    if (file && "onClick" in file) file.onClick?.();
    expect(openFile.mock.calls).toEqual(songs.map(song => [song.path]));
  });

  it("keeps single-song tag editing for an album containing one song", () => {
    const menu = songMenuItems({ ...base, selection: true, onOpenLyrics: undefined });
    expect(labels(menu).filter(label => label === i18n.t("Edit tags"))).toHaveLength(1);
  });

  it("matches the whole album selection, retains offline gating and hides Match for members", () => {
    const { result } = renderHook(useMatchScope);
    const menu = songMenuItems({ ...base, songs, selection: true });
    const match = menu.find(item => "label" in item && item.label === i18n.t("Match on MusicBrainz…"));
    act(() => { if (match && "onClick" in match) match.onClick?.(); });
    expect(result.current).toMatchObject({ relPaths: songs.map(song => song.relPath) });
    state.offline = true;
    expect(songMenuItems({ ...base, songs }).find(item => "label" in item && item.label === i18n.t("Match on MusicBrainz…"))).toMatchObject({ disabled: true });
    state.owner = false;
    expect(labels(songMenuItems({ ...base, songs }))).not.toContain(i18n.t("Match on MusicBrainz…"));
  });
});
