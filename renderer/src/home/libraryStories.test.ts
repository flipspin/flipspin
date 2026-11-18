import { describe, expect, it } from "vitest";
import { bpmBuckets, camelotCode, camelotNeighbours, decadeBuckets, genreBuckets, harmonicSongs, librarySongs, listeningBuckets } from "./libraryStories";
import type { ListedAlbum } from "./decorateTrack";

const songs = (tracks: Record<string, unknown>[], album: Partial<ListedAlbum> = {}) => librarySongs([{ ...album, tracks: tracks.map((track, i) => ({ path: `/music/${i}`, ...track })) }]);

describe("library stories", () => {
  it("bins BPM at half-open 10-BPM boundaries, including 190 in the last bin", () => {
    const bins = bpmBuckets(songs([59, 60, 69.9, 70, 120, 129, 130, 189, 190, 191, 0, null, "bad"].map(bpm => ({ bpm }))));
    expect(bins).toHaveLength(13);
    expect(bins[0].songs).toHaveLength(2);
    expect(bins[1].songs).toHaveLength(1);
    expect(bins[6].songs).toHaveLength(2);
    expect(bins[7].songs).toHaveLength(1);
    expect(bins[12].songs).toHaveLength(2);
    expect(bins.flatMap(b => b.songs)).toHaveLength(8);
  });
  it("wraps both Camelot rings and selects only the key and its three neighbours", () => {
    expect(camelotNeighbours("1A")).toEqual(["12A", "2A", "1B"]);
    expect(camelotNeighbours("12B")).toEqual(["11B", "1B", "12A"]);
    expect(camelotNeighbours("8A")).toEqual(["7A", "9A", "8B"]);
    expect(camelotNeighbours("13A")).toEqual([]);
    const all = songs(["8A", "7A", "9A", "8B", "9B", "garbage"].map(key => ({ key })));
    expect(harmonicSongs(all, "8A").map(s => s.camelot)).toEqual(["8A", "7A", "9A", "8B"]);
  });
  it("accepts conventional and enharmonic keys, and falls back from invalid analysis", () => {
    expect(camelotCode("Am")).toBe("8A");
    expect(camelotCode("C major")).toBe("8B");
    expect(camelotCode("G# minor")).toBe("1A");
    expect(camelotCode("F♯")).toBe("2B");
    expect(camelotCode("13A")).toBeNull();
    expect(songs([{ key: "Am", analysis: { camelot: "unknown" } }])[0].camelot).toBe("8A");
  });
  it("counts songs per album decade and reports missing/invalid years", () => {
    const all = [1999, 2000, "2009", null, "", "unknown"].flatMap((year, i) => librarySongs([{ year, tracks: [{ path: `/${i}/1` }, { path: `/${i}/2` }] }]));
    expect(decadeBuckets(all).buckets.map(b => [b.id, b.songs.length])).toEqual([["1990", 2], ["2000", 4]]);
    expect(decadeBuckets(all).missing).toBe(6);
  });
  it("uses track genres before album genres; splits and deduplicates, counts missing songs", () => {
    const all = songs([{ genre: "Jazz; Jazz" }, { genre: ["Rock", "Soul"] }, { genre: "  " }], { genre: "Pop" });
    const result = genreBuckets([...all, ...librarySongs([{ tracks: [{ path: "/missing" }] }])]);
    expect(result.buckets.map(b => [b.id, b.songs.length])).toEqual([["Jazz", 1], ["Pop", 1], ["Rock", 1], ["Soul", 1]]);
    expect(result.missing).toBe(1);
  });
  it("sums device plays by artist and estimates hours as sum(plays × duration)/3600", () => {
    const all = songs([{ artist: "A", duration: 1800 }, { artist: "A", duration: 900 }, { artist: "B", duration: 3600 }, { artist: "C", duration: -2 }]);
    const result = listeningBuckets(all, { "/music/0": { n: 2, at: 0 }, "/music/1": { n: 4, at: 0 }, "/music/2": { n: 1, at: 0 }, "/deleted": { n: 100, at: 0 } });
    expect(result.hours).toBe(3);
    expect(result.plays).toBe(7);
    expect(result.buckets.map(b => [b.id, b.plays, b.songs.length])).toEqual([["A", 6, 2], ["B", 1, 1]]);
  });
  it("shows an artist's other library albums even when they have no device plays", () => {
    const heard: ListedAlbum = { artist: "A", album: "Heard", tracks: [{ path: "/heard", duration: 180 }] };
    const other: ListedAlbum = { artist: "A", album: "Other", tracks: [{ path: "/other" }] };
    const result = listeningBuckets(librarySongs([heard, other]), { "/heard": { n: 2, at: 0 } });
    expect(result.buckets[0].albums).toEqual([heard, other]);
    expect(result.buckets[0].songs.map(s => s.track.path)).toEqual(["/heard"]);
    expect(result.hours).toBe(.1);
  });
  it("deduplicates paths and tolerates partial metadata", () => {
    const all = librarySongs([{ tracks: [{ path: "/same", analysis: null, duration: "240", bpm: "120" }, { path: "/same" }] }]);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ bpm: 120, duration: 240, camelot: null, energy: null });
  });
});
