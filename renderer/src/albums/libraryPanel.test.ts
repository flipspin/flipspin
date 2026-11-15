import { describe, expect, it } from "vitest";
import { albumIdByPath, albumTracksInOrder, mediaPathOf, narrowAlbums, suggestedFileName } from "./libraryPanel";

describe("mediaPathOf", () => {
  it("strips the query string a token-bearing url_path carries", () => {
    expect(mediaPathOf({ url_path: "http://n:8000/api/media/A/1.mp3?access_token=x" })).toBe("http://n:8000/api/media/A/1.mp3");
  });

  it("is empty without a url_path", () => {
    expect(mediaPathOf(null)).toBe("");
    expect(mediaPathOf({})).toBe("");
  });
});

describe("suggestedFileName", () => {
  it("is the file's own name", () => {
    expect(suggestedFileName({ path: "/m/Album/01 One.flac", title: "One" })).toBe("01 One.flac");
    expect(suggestedFileName({ path: "C:\\m\\Album\\02.mp3" })).toBe("02.mp3");
  });

  it("falls back to the title, then to «cancion»", () => {
    expect(suggestedFileName({ title: "One" })).toBe("One.mp3");
    expect(suggestedFileName(null)).toBe("cancion.mp3");
  });
});

describe("albumTracksInOrder", () => {
  it("sorts by track number, unnumbered last, without touching the album", () => {
    const album = { tracks: [{ path: "c" }, { path: "b", track_number: "2" }, { path: "a", track_number: 1 }] };
    expect(albumTracksInOrder(album).map((t) => t.path)).toEqual(["a", "b", "c"]);
    expect(album.tracks[0].path).toBe("c");
  });

  it("is empty for no album", () => {
    expect(albumTracksInOrder(null)).toEqual([]);
  });
});

describe("albumIdByPath", () => {
  it("maps each track to its album's id", () => {
    const albums = [{ id: "x", tracks: [{ path: "1" }, { path: "2" }] }, { id: "y", tracks: [{ path: "3" }] }];
    const m = albumIdByPath(albums, (a) => a.id);
    expect([...m.entries()]).toEqual([["1", "x"], ["2", "x"], ["3", "y"]]);
  });
});

describe("narrowAlbums", () => {
  it("keeps only matching songs and drops emptied albums", () => {
    const albums = [{ album: "A", tracks: [{ path: "1" }, { path: "2" }] }, { album: "B", tracks: [{ path: "3" }] }];
    expect(narrowAlbums(albums, (t) => t.path !== "3" && t.path !== "2")).toEqual([{ album: "A", tracks: [{ path: "1" }] }]);
  });
});
