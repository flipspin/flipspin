import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIBRARY_HISTORY_KEY, librarySearchHistory, librarySearchIndex, searchLibrary } from "./librarySearch";
import { readRecentSearches, rememberSearch } from "../../browse/catalogSearchHistory";

beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe("library search history on this computer", () => {
  it("saves, deduplicates accents and case, removes, and keeps legacy readers scoped while recording into the shared list", () => {
    rememberSearch("catalog only");
    for (let i = 0; i < 10; i++) librarySearchHistory.rememberSearch(`term ${i}`);
    expect(librarySearchHistory.readRecentSearches()).toEqual([9, 8, 7, 6, 5, 4, 3, 2].map(i => `term ${i}`));
    librarySearchHistory.rememberSearch("  Térm 9  ");
    expect(librarySearchHistory.readRecentSearches()).toHaveLength(8);
    expect(librarySearchHistory.readRecentSearches()[0]).toBe("Térm 9");
    librarySearchHistory.removeRecentSearch("Térm 9");
    expect(librarySearchHistory.readRecentSearches()).toHaveLength(8);
    expect(JSON.parse(localStorage.getItem(LIBRARY_HISTORY_KEY)!)).toHaveLength(8);
    expect(readRecentSearches()).toEqual(["catalog only"]);
    librarySearchHistory.rememberSearch("x");
    expect(librarySearchHistory.readRecentSearches()[0]).toBe("x");
  });
  it("tolerates corrupt and unavailable storage", () => {
    localStorage.setItem(LIBRARY_HISTORY_KEY, "{");
    expect(librarySearchHistory.readRecentSearches()).toEqual([]);
    const read = vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("denied"); });
    const write = vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => librarySearchHistory.rememberSearch("test")).not.toThrow();
    expect(librarySearchHistory.removeRecentSearch("test")).toEqual([]);
    read.mockRestore(); write.mockRestore();
  });
});

describe("ranked library groups", () => {
  const albums = [{ album: "Corazón", artist: "Beyoncé", path: "/music/corazon", tracks: [
    { path: "/music/corazon/1.mp3", title: "Corazoncito" },
    { path: "/music/corazon/2.mp3", title: "Corazón" },
  ] }];
  const index = librarySearchIndex(albums, [{ name: "Beyoncé en casa" }]);
  it("folds accents, requires every word across fields, and ranks exact words first", () => {
    expect(searchLibrary(index, "BEYONCE corazon").songs.map(song => song.title)).toEqual(["Corazón", "Corazoncito"]);
    expect(searchLibrary(index, "beyonce absent").songs).toEqual([]);
    expect(searchLibrary(index, "beyonce").artists[0].name).toBe("Beyoncé");
    expect(searchLibrary(index, "beyonce").artists[0].songs).toBe(2);
    expect(searchLibrary(index, "beyonce").artists[0].albums.size).toBe(1);
    expect(searchLibrary(index, "beyonce").albums).toHaveLength(1);
    expect(searchLibrary(index, "beyonce").playlists).toHaveLength(1);
    expect(searchLibrary(index, " ")).toEqual({ artists: [], albums: [], songs: [], playlists: [] });
  });
});
