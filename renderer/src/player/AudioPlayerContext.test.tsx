import React from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AudioPlayerProvider, useAudioPlayer, useAudioProgress } from "@state/AudioPlayerContext";
import { STORAGE_BASE, STORAGE_NOW, STORAGE_QUEUE, STORAGE_SHUFFLE } from "@state/playerQueue";

const wrapper = ({ children }: { children?: React.ReactNode }) => <AudioPlayerProvider>{children}</AudioPlayerProvider>;
const tr = (path: string) => ({ path, title: path });
const paths = (list: { path: string }[]) => list.map((t) => t.path);

describe("AudioPlayerProvider", () => {
  beforeEach(() => localStorage.clear());

  it("plays a song with what follows it queued, and walks forward and back", () => {
    const { result } = renderHook(() => useAudioPlayer(), { wrapper });
    act(() => result.current.play(tr("a"), { replaceQueue: true, upcomingTracks: [tr("b"), tr("c")] }));
    expect(result.current.nowPlaying?.path).toBe("a");
    expect(result.current.selectedTrack?.path).toBe("a");
    expect(result.current.isPlaying).toBe(true);
    expect(paths(result.current.queue)).toEqual(["b", "c"]);

    act(() => result.current.goNext());
    expect(result.current.nowPlaying?.path).toBe("b");
    expect(paths(result.current.history)).toEqual(["a"]);

    act(() => result.current.goPrevious());
    expect(result.current.nowPlaying?.path).toBe("a");
    expect(paths(result.current.queue)).toEqual(["b", "c"]);
  });

  it("adds next and at the end, removes and reorders", () => {
    const { result } = renderHook(() => useAudioPlayer(), { wrapper });
    act(() => result.current.play(tr("a"), { replaceQueue: true, upcomingTracks: [tr("b")] }));
    act(() => result.current.addNextInQueue([tr("n")]));
    act(() => result.current.addToQueue(tr("z")));
    expect(paths(result.current.queue)).toEqual(["n", "b", "z"]);
    act(() => result.current.reorderQueue(2, 0));
    expect(paths(result.current.queue)).toEqual(["z", "n", "b"]);
    act(() => result.current.removeFromQueue(1));
    expect(paths(result.current.queue)).toEqual(["z", "b"]);
    act(() => result.current.clearAll());
    expect(result.current.nowPlaying).toBeNull();
    expect(result.current.queue).toEqual([]);
  });

  it("remembers which playlist is playing until something else replaces the queue", () => {
    const { result } = renderHook(() => useAudioPlayer(), { wrapper });
    expect(result.current.source).toBeNull();
    act(() => result.current.play(tr("a"), { replaceQueue: true, upcomingTracks: [tr("b")], source: { kind: "playlist", name: "Jazz" } }));
    expect(result.current.source).toEqual({ kind: "playlist", name: "Jazz" });
    // Editing the queue keeps it: still the same playlist playing.
    act(() => result.current.addToQueue(tr("z")));
    act(() => result.current.goNext());
    expect(result.current.source).toEqual({ kind: "playlist", name: "Jazz" });
    // An album or a single song replaces the queue and drops it.
    act(() => result.current.play(tr("x"), { replaceQueue: true, upcomingTracks: [] }));
    expect(result.current.source).toBeNull();
    act(() => result.current.setQueueWithTracks([tr("p"), tr("q")], 0, { kind: "playlist", name: "Rock" }));
    expect(result.current.source).toEqual({ kind: "playlist", name: "Rock" });
    act(() => result.current.clearQueue());
    expect(result.current.source).toBeNull();
  });

  it("shuffles from the whole context and restores the natural order", () => {
    const { result } = renderHook(() => useAudioPlayer(), { wrapper });
    const list = [tr("a"), tr("b"), tr("c"), tr("d")];
    act(() => result.current.play(list[2], { replaceQueue: true, upcomingTracks: [list[3]], context: list }));
    act(() => result.current.toggleShuffle());
    expect(result.current.shuffleEnabled).toBe(true);
    expect(paths(result.current.queue).sort()).toEqual(["a", "b", "d"]);
    expect(localStorage.getItem(STORAGE_SHUFFLE)).toBe("true");
    act(() => result.current.toggleShuffle());
    expect(paths(result.current.queue)).toEqual(["d"]);
  });

  it("persists the song at once and the queue after a pause, under the same keys", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useAudioPlayer(), { wrapper });
      act(() => result.current.play(tr("a"), { replaceQueue: true, upcomingTracks: [tr("b")] }));
      expect(JSON.parse(localStorage.getItem(STORAGE_NOW) || "null")?.path).toBe("a");
      act(() => { vi.advanceTimersByTime(600); });
      expect(paths(JSON.parse(localStorage.getItem(STORAGE_QUEUE) || "[]"))).toEqual(["b"]);
      expect(paths(JSON.parse(localStorage.getItem(STORAGE_BASE) || "[]"))).toEqual(["b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores what the last session left", () => {
    localStorage.setItem(STORAGE_NOW, JSON.stringify(tr("n")));
    localStorage.setItem(STORAGE_QUEUE, JSON.stringify([tr("q")]));
    const { result } = renderHook(() => useAudioPlayer(), { wrapper });
    expect(result.current.nowPlaying?.path).toBe("n");
    expect(paths(result.current.queue)).toEqual(["q"]);
    expect(JSON.parse(localStorage.getItem(STORAGE_NOW) || "null")?.path).toBe("n");
  });

  it("serves the playhead from its own context", () => {
    const { result } = renderHook(() => useAudioProgress(), { wrapper });
    expect(result.current).toMatchObject({ progress: 0, duration: 0 });
  });

  it("refuses to be read outside the provider", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useAudioPlayer())).toThrow(/AudioPlayerProvider/);
    spy.mockRestore();
  });
});

describe('album levelling context', () => {
  beforeEach(() => localStorage.clear());
  const album = [1, 2, 3].map(n => ({ path: `/music/Album/${n}.mp3`, relPath: `Album/${n}.mp3` }));
  it('retains album order across next/previous, falls back during shuffle and manual edits', () => {
    const { result } = renderHook(useAudioPlayer, { wrapper });
    act(() => result.current.play(album[0], { replaceQueue: true, context: album, upcomingTracks: album.slice(1) }));
    expect(result.current.albumOrder).toBe(true);
    act(() => result.current.goNext());
    expect(result.current.albumOrder).toBe(true);
    act(() => result.current.toggleShuffle());
    expect(result.current.albumOrder).toBe(false);
    act(() => result.current.toggleShuffle());
    expect(result.current.albumOrder).toBe(true);
    act(() => result.current.reorderQueue(0, 1));
    expect(result.current.albumOrder).toBe(false);
    act(() => result.current.setQueueWithTracks(album));
    expect(result.current.albumOrder).toBe(true);
    act(() => result.current.playQueueItemAt(1));
    expect(result.current.albumOrder).toBe(false);
  });
  it('uses track gain for a playlist, mixed artists, or a single selected song', () => {
    const { result } = renderHook(useAudioPlayer, { wrapper });
    act(() => result.current.setQueueWithTracks(album, 0, { kind: 'playlist', name: 'List' }));
    expect(result.current.albumOrder).toBe(false);
    act(() => result.current.play(album[0], { replaceQueue: true }));
    expect(result.current.albumOrder).toBe(false);
  });
});
