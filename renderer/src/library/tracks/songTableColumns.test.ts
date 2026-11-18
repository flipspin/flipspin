import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

import {
  SONG_COLUMNS,
  _reloadFromStorageForTest,
  _resetForTest,
  getState,
  emptySongColumns,
  isColumnVisible,
  resetColumns,
  setColumnVisible,
  setColumnOrder,
  songTableGridStyle,
  setCoversVisible,
  songTableRootClass,
  toggleColumn,
  useEmptySongColumns,
} from "./songTableColumns";

// jsdom serves this suite from an opaque origin and exposes no `localStorage`.
// The module has already been imported by the time this runs, which is the
// point: its load path must survive a missing storage, not only a bad one.
beforeAll(() => {
  const backing = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => void backing.set(k, String(v)),
    removeItem: (k: string) => void backing.delete(k),
  });
});

afterEach(() => {
  _resetForTest();
});

describe("songTableColumns", () => {
  it("normalizes saved order, keeping first occurrences and appending every missing column", () => {
    localStorage.setItem("krobi.songTable.columnOrder", JSON.stringify(["duration", "title", "album", "duration", "unknown", 42]));
    localStorage.setItem("krobi.songTable.hiddenColumns", JSON.stringify(["genre", "bpm"]));
    _reloadFromStorageForTest();
    expect(getState().order).toEqual(["duration", "album", "artist", "genre", "date", "analysis", "key", "bpm", "lyrics"]);
    expect(getState().hidden).toEqual(["genre", "bpm"]);
    expect(localStorage.getItem("krobi.songTable.hiddenColumns")).toBe('["genre","bpm"]');
  });

  it.each(["bad json", "null", "{}", "42"])("defaults invalid order %s independently of visibility", value => {
    localStorage.setItem("krobi.songTable.columnOrder", value);
    setColumnVisible("artist", false);
    _reloadFromStorageForTest();
    expect(getState().order).toEqual(SONG_COLUMNS.map(column => column.id));
    expect(getState().hidden).toEqual(["artist"]);
  });

  it("persists order independently, preserves it on Show all and keeps snapshots stable on no-op writes", () => {
    setColumnVisible("album", false);
    const hiddenStorage = localStorage.getItem("krobi.songTable.hiddenColumns");
    const order = [...getState().order].reverse();
    setColumnOrder(order);
    expect(localStorage.getItem("krobi.songTable.hiddenColumns")).toBe(hiddenStorage);
    const before = getState();
    setColumnOrder([...order]);
    expect(getState()).toBe(before);
    resetColumns();
    expect(getState().order).toBe(before.order);
    _reloadFromStorageForTest();
    expect(getState().order).toEqual(order);
    expect(getState().hidden).toEqual([]);
    expect(songTableGridStyle(order)).toEqual({ "--sc-template": ["num", "cover", "title", ...order, "end"].map(id => `[${id}] var(--sc-${id})`).join(" ") });
  });

  it("auto-hides only empty optional columns, including whitespace and empty genre tags", () => {
    const items = [{ path: "/music/album/song.mp3", genre: ["", " , "] }];
    expect(emptySongColumns(items)).toEqual(["genre", "date", "analysis", "key", "bpm", "lyrics"]);
    expect(emptySongColumns([])).toEqual(["genre", "date", "analysis", "key", "bpm", "lyrics"]);
    expect(emptySongColumns([...items, { path: "/music/album/other.mp3", genre: ["", "Rock"] }])).not.toContain("genre");
  });

  it("finds values anywhere in the list, including playlist dates under metadata", () => {
    const items = [
      { path: "/music/album/first.mp3", genre: "" },
      { path: "/music/album/last.mp3", genre: "Rock", key: "3A", bpm: 120, metadata: { dateAdded: 123 } },
    ];
    expect(emptySongColumns(items, { "album/last.mp3": "synced" })).toEqual([]);
    expect(emptySongColumns([{ path: "x", mood: "Happy" }])).not.toContain("analysis");
    expect(emptySongColumns([{ path: "x", analysis: { key: "C" } }])).not.toContain("analysis");
  });

  it("keeps Letra empty for absent words, and restores it when words arrive", () => {
    const items = [{ path: "/music/album/song.mp3" }];
    for (const state of ["none", "pending", "instrumental", "queued"] as const) {
      expect(emptySongColumns(items, { "album/song.mp3": state })).toContain("lyrics");
    }
    expect(emptySongColumns(items, { "album/song.mp3": "plain" })).not.toContain("lyrics");
  });

  it("merges auto-hidden columns with preferences without persisting availability", () => {
    setColumnVisible("genre", true);
    const saved = getState();
    expect(songTableRootClass(saved, false, "library", ["genre"])).toContain("song-table--hide-genre");
    expect(getState()).toBe(saved);
    expect(songTableRootClass(saved, false, "library", [])).not.toContain("song-table--hide-genre");
    setColumnVisible("genre", false);
    expect(songTableRootClass(getState(), false, "library", [])).toContain("song-table--hide-genre");
    expect(songTableRootClass(getState(), false, "library", ["genre"]).match(/song-table--hide-genre/g)).toHaveLength(1);
  });

  it("does not rescan on unrelated rerenders, and recalculates for a new items array or lyric index", () => {
    const genre = vi.fn(() => "");
    const items = [{ path: "/music/album/song.mp3", get genre() { return genre(); } }];
    const states = {};
    const { result, rerender } = renderHook(({ items, states }) => useEmptySongColumns(items, states), { initialProps: { items, states } });
    const first = result.current;
    const reads = genre.mock.calls.length;
    rerender({ items, states });
    expect(result.current).toBe(first);
    expect(genre).toHaveBeenCalledTimes(reads);
    rerender({ items: [...items], states });
    expect(genre.mock.calls.length).toBeGreaterThan(reads);
    rerender({ items, states: { "album/song.mp3": "plain" } });
    expect(result.current).not.toContain("lyrics");
  });

  it("defaults covers on in playlists and off in Library, independently of column choices", () => {
    expect(getState().covers).toEqual({ playlist: true, library: false });
    expect(songTableRootClass(getState(), false, "playlist")).toBe("song-table--covers");
    expect(songTableRootClass(getState(), false, "library")).toBe("");
  });

  it("persists each table's cover choice without changing the other or the artist preference", () => {
    setCoversVisible("playlist", false);
    _reloadFromStorageForTest();
    expect(getState().covers).toEqual({ playlist: false, library: false });
    setCoversVisible("library", true);
    _reloadFromStorageForTest();
    expect(getState().covers).toEqual({ playlist: false, library: true });
    expect(getState().hidden).toEqual([]);
    expect(isColumnVisible("artist")).toBe(true);
    expect(JSON.parse(localStorage.getItem("krobi.songTable.covers")!)).toEqual({ playlist: false, library: true });
  });

  it("validates stored cover values and keeps valid choices if hidden column storage is corrupt", () => {
    localStorage.setItem("krobi.songTable.covers", JSON.stringify({ library: true, playlist: "false", other: true }));
    localStorage.setItem("krobi.songTable.hiddenColumns", "bad json");
    _reloadFromStorageForTest();
    expect(getState().covers).toEqual({ library: true, playlist: true });
    localStorage.setItem("krobi.songTable.covers", "bad json");
    _reloadFromStorageForTest();
    expect(getState().covers).toEqual({ library: false, playlist: true });
  });

  it("keeps cover choices when restoring all optional columns", () => {
    setCoversVisible("library", true);
    toggleColumn("artist");
    resetColumns();
    expect(getState().covers.library).toBe(true);
    expect(getState().hidden).toEqual([]);
  });
  it("shows every column until told otherwise", () => {
    expect(getState().hidden).toEqual([]);
    expect(songTableRootClass()).toBe("");
    for (const column of SONG_COLUMNS) expect(isColumnVisible(column.id)).toBe(true);
  });

  it("toggles a column off and on, and the root class follows", () => {
    toggleColumn("album");
    expect(isColumnVisible("album")).toBe(false);
    expect(songTableRootClass()).toBe("song-table--hide-album");
    toggleColumn("album");
    expect(isColumnVisible("album")).toBe(true);
    expect(songTableRootClass()).toBe("");
  });

  it("keeps hidden ids in column order however they were hidden", () => {
    toggleColumn("duration");
    toggleColumn("artist");
    expect(getState().hidden).toEqual(["artist", "duration"]);
  });

  it("persists across a reload", () => {
    setColumnVisible("bpm", false);
    expect(JSON.parse(localStorage.getItem("krobi.songTable.hiddenColumns") ?? "[]")).toEqual(["bpm"]);
    _reloadFromStorageForTest();
    expect(getState().hidden).toEqual(["bpm"]);
  });

  it("persists Key visibility independently of BPM", () => {
    setColumnVisible("key", false);
    _reloadFromStorageForTest();
    expect(isColumnVisible("key")).toBe(false);
    expect(isColumnVisible("bpm")).toBe(true);
    expect(songTableRootClass()).toBe("song-table--hide-key");
    resetColumns();
    expect(isColumnVisible("key")).toBe(true);
  });

  it("ignores ids it does not know, so «Título» can never be hidden", () => {
    localStorage.setItem("krobi.songTable.hiddenColumns", JSON.stringify(["date", "title", 42, "nope"]));
    _reloadFromStorageForTest();
    expect(getState().hidden).toEqual(["date"]);
  });

  it("survives garbage in storage", () => {
    localStorage.setItem("krobi.songTable.hiddenColumns", "{not json");
    _reloadFromStorageForTest();
    expect(getState().hidden).toEqual([]);
  });

  it("does not notify when nothing changed", () => {
    const before = getState();
    resetColumns();
    expect(getState()).toBe(before);
  });
});
