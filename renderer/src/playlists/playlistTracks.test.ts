import { afterEach, describe, expect, it } from "vitest";
import { filterTracks, toQueueTrack, toRow, withCovers, withLibraryMeta, type PlaylistTrack } from "./playlistTracks";

import { ROOT_ALBUM_KEY, setLibraryRoot } from "@lib/libraryKeys";

afterEach(() => setLibraryRoot(null));

const discovery = { album: "Discovery", artist: "Daft Punk", cover: "disc.jpg", tracks: [{ path: "/m/Discovery/01.mp3", bpm: 123, key: "8A", analysis: { mood: "x" } }] };

describe("withCovers", () => {
  it("takes the cover of the library album the track belongs to", () => {
    const [out] = withCovers([{ path: "/m/Discovery/01.mp3", album: "discovery" }], [discovery]);
    expect(out.albumCover).toBe("disc.jpg");
  });

  it("falls back to the track's own cover, then its folder's cover.jpg", () => {
    expect(withCovers([{ path: "/m/X/1.mp3", albumCover: "own.jpg" }], [])[0].albumCover).toBe("own.jpg");
    expect(withCovers([{ path: "/m/X/1.mp3" }], [])[0].albumCover).toContain("/api/media/X/cover.jpg");
  });
});

describe("toQueueTrack", () => {
  it("builds the media URL from the path and carries an album stub, never the album with its tracks", () => {
    const out = toQueueTrack({ path: "/m/Discovery/01.mp3", album: "Discovery" }, [discovery]);
    expect(out.url_path).toContain("/api/media/Discovery/01.mp3");
    expect(out.album).toMatchObject({ album: "Discovery", artist: "Daft Punk", cover: "disc.jpg" });
    expect(out.album).not.toHaveProperty("tracks");
  });

  it("names an unknown string album and artist", () => {
    const out = toQueueTrack({ path: "1.mp3" }, []);
    expect(out.album).toMatchObject({ album: "Unknown Album", artist: "Unknown Artist" });
  });
});

describe("withLibraryMeta", () => {
  it("fills BPM, key and analysis from the library track, by path then by file name", () => {
    const [byPath, byName, none] = withLibraryMeta(
      [{ path: "/m/Discovery/01.mp3" }, { path: "/elsewhere/01.mp3" }, { path: "/m/Other/9.mp3" }],
      [discovery],
    );
    expect(byPath).toMatchObject({ bpm: 123, key: "8A", analysis: { mood: "x" } });
    expect(byName.bpm).toBe(123);
    expect(none).toEqual({ path: "/m/Other/9.mp3" });
  });

  it("preserves the key estimate and provenance through enrichment and row normalization", () => {
    const path = "/music/Record/song.mp3";
    for (const source of ["computed", "tag", "fixed"]) {
      const enriched = withLibraryMeta([{ path }], [{ tracks: [{ path, key: "3A", keySource: source, keyEstimated: source === "computed", keyFixed: source === "fixed" }] }])[0];
      expect(toRow(enriched).rowTrack).toMatchObject({ key: "3A", keySource: source, keyEstimated: source === "computed", keyFixed: source === "fixed" });
    }
    const [existing] = withLibraryMeta([{ path, key: "2A", keySource: "fixed", keyEstimated: false, keyFixed: true }], [{ tracks: [{ path, key: "3A", keySource: "computed", keyEstimated: true, keyFixed: false }] }]);
    expect(existing).toMatchObject({ key: "2A", keySource: "fixed", keyEstimated: false, keyFixed: true });
  });

  it("keeps what the playlist already says", () => {
    expect(withLibraryMeta([{ path: "/m/Discovery/01.mp3", bpm: 90 }], [discovery])[0].bpm).toBe(90);
  });
});

describe("filterTracks", () => {
  const tracks: PlaylistTrack[] = [
    { path: "1", title: "One More Time", artist: "Daft Punk" },
    { path: "2", title: "Song", album: { album: "Homework", artist: "DP" } },
    { path: "3", title: "Other", album: null },
  ];

  it("matches title, artist or album, case-insensitively", () => {
    expect(filterTracks(tracks, "more").map((t) => t.path)).toEqual(["1"]);
    expect(filterTracks(tracks, "HOMEWORK").map((t) => t.path)).toEqual(["2"]);
    expect(filterTracks(tracks, "dp").map((t) => t.path)).toEqual(["2"]);
  });

  it("returns the list itself for an empty query", () => {
    expect(filterTracks(tracks, "")).toBe(tracks);
  });
});

describe("toRow", () => {
  it("flattens the album object and the nested metadata", () => {
    const { rowTrack, albumName, artistName } = toRow({
      path: "/m/Folder/1.mp3",
      album: { album: "Discovery", artist: " Daft Punk " },
      metadata: { dateAdded: 5, duration: 200 },
    });
    expect([albumName, artistName]).toEqual(["Discovery", "Daft Punk"]);
    expect(rowTrack).toMatchObject({ album: "Discovery", artist: "Daft Punk", dateAdded: 5, duration: 200 });
  });

  it("names a missing album after its folder", () => {
    expect(toRow({ path: "/m/Folder/1.mp3" }).albumName).toBe("Folder");
  });
});

describe('toQueueTrack on an imported playlist', () => {
  it('plays a song filed one folder deeper (Music/<playlist>/<album>/song) through the nested album key', async () => {
    const { setLibraryRoot } = await import('@lib/libraryKeys')
    const { toQueueTrack: queueTrack } = await import('./playlistTracks')
    setLibraryRoot('/home/krobi/Krobi/Music')
    try {
      const track = queueTrack({ path: '/home/krobi/Krobi/Music/mindthegap/The Low End Theory/Excursions.mp3', title: 'Excursions' }, [])
      expect(decodeURIComponent(String(track.url_path))).toContain('/api/media/mindthegap∕The Low End Theory/Excursions.mp3')
    } finally {
      setLibraryRoot(null)
    }
  })
})


describe("root songs in playlists", () => {
  it("builds a playable two-segment URL and cover from an absolute root song path", () => {
    setLibraryRoot("/music");
    const track = toQueueTrack({ path: "/music/Loose Song.mp3" }, []);
    const url = new URL(String(track.url_path), "http://localhost");
    expect(decodeURIComponent(url.pathname)).toBe(`/api/media/${ROOT_ALBUM_KEY}/Loose Song.mp3`);
    expect(url.pathname.split("/").slice(-2)).toEqual([ROOT_ALBUM_KEY, "Loose%20Song.mp3"]);
    expect(track.albumCover).toContain(`/api/media/${ROOT_ALBUM_KEY}/cover.jpg`);
  });
});


it("carries computed confidence through playlist rows and player queues without borrowing it for another value", () => {
  const libraryTrack = { path: "/music/Album/song.mp3", key: "3A", bpm: 94, keyConfidence: 0.012, bpmConfidence: 0.31, keySource: "computed", bpmSource: "computed", keyEstimated: false, bpmEstimated: true }
  const albums = [{ album: "Album", tracks: [libraryTrack] }]
  const [enriched] = withLibraryMeta([{ path: libraryTrack.path }], albums)
  for (const track of [enriched, toRow(enriched).rowTrack, toQueueTrack(enriched, albums)]) {
    expect(track).toMatchObject({ keyConfidence: 0.012, bpmConfidence: 0.31, bpmSource: "computed", bpmEstimated: true })
  }
  expect(withLibraryMeta([{ path: libraryTrack.path, bpm: 126, key: "8B" }], albums)[0]).toMatchObject({ bpmConfidence: null, keyConfidence: null })
})
