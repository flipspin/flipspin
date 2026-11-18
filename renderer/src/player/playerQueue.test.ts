import { beforeEach, describe, expect, it } from "vitest";
import {
  STORAGE_BASE,
  STORAGE_INDEX,
  STORAGE_NOW,
  STORAGE_QUEUE,
  loadPersisted,
  nowPlayingMetadata,
  shuffleArray,
  shufflePool,
  slim,
  withoutOne,
  type PlayerTrack,
} from "@state/playerQueue";

// The pure half of AudioPlayerContext (it lives beside the context, outside the
// vitest include, so its tests live here).

const tr = (path: string, extra: Record<string, unknown> = {}): PlayerTrack => ({ path, ...extra });

describe("shuffleArray", () => {
  it("returns a permutation and leaves the input alone", () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffleArray(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
    expect([...out].sort()).toEqual(input);
  });

  it("is Fisher–Yates over the given random source", () => {
    // random() = 0 always picks j = 0: each step swaps i with the head.
    expect(shuffleArray(["a", "b", "c"], () => 0)).toEqual(["b", "c", "a"]);
  });
});

describe("slim", () => {
  it("replaces an album that embeds its tracks with the stub", () => {
    const album = { album: "Discovery", artist: "Daft Punk", cover: "c.jpg", tracks: [{ path: "x" }] };
    const out = slim(tr("a/1.mp3", { album }));
    expect(out.album).toEqual({ album: "Discovery", name: undefined, artist: "Daft Punk", path: null, year: null, genre: null, cover: "c.jpg" });
  });

  it("returns the same object when there is nothing to slim", () => {
    const already = tr("a/1.mp3", { album: { album: "Discovery" } });
    expect(slim(already)).toBe(already);
    const bare = tr("a/1.mp3", { album: "Discovery" });
    expect(slim(bare)).toBe(bare);
    expect(slim(null)).toBe(null);
  });
});

describe("loadPersisted", () => {
  beforeEach(() => localStorage.clear());

  it("is empty with nothing stored", () => {
    expect(loadPersisted()).toEqual({ nowPlaying: null, queue: [], base: [] });
  });

  it("restores the playing song, the live queue and the natural baseline apart", () => {
    localStorage.setItem(STORAGE_NOW, JSON.stringify(tr("n")));
    localStorage.setItem(STORAGE_QUEUE, JSON.stringify([tr("b"), tr("a")]));
    localStorage.setItem(STORAGE_BASE, JSON.stringify([tr("a"), tr("b")]));
    expect(loadPersisted()).toEqual({ nowPlaying: tr("n"), queue: [tr("b"), tr("a")], base: [tr("a"), tr("b")] });
  });

  it("falls back to the queue as baseline when an older build stored none", () => {
    localStorage.setItem(STORAGE_NOW, JSON.stringify(tr("n")));
    localStorage.setItem(STORAGE_QUEUE, JSON.stringify([tr("b")]));
    expect(loadPersisted().base).toEqual([tr("b")]);
  });

  it("migrates the index-based format", () => {
    localStorage.setItem(STORAGE_QUEUE, JSON.stringify([tr("a"), tr("b"), tr("c")]));
    localStorage.setItem(STORAGE_INDEX, "1");
    expect(loadPersisted()).toEqual({ nowPlaying: tr("b"), queue: [tr("c")], base: [tr("c")] });
  });

  it("ignores unreadable JSON", () => {
    localStorage.setItem(STORAGE_NOW, "{nope");
    expect(loadPersisted()).toEqual({ nowPlaying: null, queue: [], base: [] });
  });
});

describe("shufflePool", () => {
  it("is the queue when the play had no context", () => {
    const base = [tr("a")];
    expect(shufflePool([], base, null)).toBe(base);
  });

  it("is the context minus the playing song, plus hand-queued extras", () => {
    const context = [tr("a"), tr("b"), tr("c")];
    const base = [tr("c"), tr("x")];
    expect(shufflePool(context, base, tr("b")).map((t) => t.path)).toEqual(["a", "c", "x"]);
  });
});

describe("withoutOne", () => {
  it("drops only the first occurrence", () => {
    expect(withoutOne([tr("a"), tr("b"), tr("a")], "a").map((t) => t.path)).toEqual(["b", "a"]);
  });

  it("returns the same list when the path is absent or empty", () => {
    const list = [tr("a")];
    expect(withoutOne(list, "z")).toBe(list);
    expect(withoutOne(list, null)).toBe(list);
  });
});

describe("nowPlayingMetadata", () => {
  it("reads the album object and its cover", () => {
    const meta = nowPlayingMetadata(tr("/m/Disc/1.mp3", { title: "One", album: { album: "Disc", artist: "Art", cover: "c.jpg" } }));
    expect(meta).toEqual({ title: "One", artist: "Art", album: "Disc", artwork: [{ src: "c.jpg", sizes: "512x512", type: "image/jpeg" }] });
  });

  it("keeps a string album and prefers the track's own artist", () => {
    const meta = nowPlayingMetadata(tr("1.mp3", { artist: "Me", album: "Tag", albumCover: "k.jpg" }));
    expect(meta).toMatchObject({ artist: "Me", album: "Tag", artwork: [{ src: "k.jpg" }] });
  });
});
