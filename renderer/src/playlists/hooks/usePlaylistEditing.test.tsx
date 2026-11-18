import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePlaylistEditing } from "./usePlaylistEditing";
import { putPlaylistTracks } from "../playlistApi";
vi.mock("../playlistApi", () => ({ putPlaylistTracks: vi.fn() }));
const tracks = [{ path: "a" }, { path: "b" }];
const next = [...tracks].reverse();
const props = () => ({ selectedPlaylist: { name: "Example" }, selectedPlaylistName: "Example", playlistTracks: tracks, setPlaylistTracks: vi.fn(), setSelectedPlaylist: vi.fn(), loadPlaylists: vi.fn().mockResolvedValue(undefined), showSuccess: vi.fn(), showError: vi.fn() });

describe("optimistic playlist saves", () => {
  beforeEach(() => { vi.mocked(putPlaylistTracks).mockReset(); });
  it("updates immediately, sends the full order once, then refreshes", async () => {
    let resolve: (response: Response) => void;
    vi.mocked(putPlaylistTracks).mockReturnValue(new Promise(r => { resolve = r; }));
    const p = props();
    const { result } = renderHook(() => usePlaylistEditing(p));
    let saving: Promise<boolean>;
    act(() => { saving = result.current.updatePlaylistTracks(next); });
    expect(p.setPlaylistTracks).toHaveBeenCalledWith(next);
    expect(result.current.saving).toBe(true);
    await act(async () => { expect(await result.current.updatePlaylistTracks(tracks)).toBe(false); });
    expect(putPlaylistTracks).toHaveBeenCalledOnce();
    await act(async () => { resolve(new Response(null, { status: 200 })); await saving; });
    expect(putPlaylistTracks).toHaveBeenCalledExactlyOnceWith("Example", next);
    expect(p.loadPlaylists).toHaveBeenCalledOnce();
    expect(p.showError).not.toHaveBeenCalled();
    expect(result.current.saving).toBe(false);
  });
  it("does not save the unchanged list", async () => {
    const p = props();
    const { result } = renderHook(() => usePlaylistEditing(p));
    await act(async () => { expect(await result.current.updatePlaylistTracks(tracks)).toBe(false); });
    expect(putPlaylistTracks).not.toHaveBeenCalled();
    expect(p.setPlaylistTracks).not.toHaveBeenCalled();
  });
  it("rolls back a 403 and explains whose playlist it is", async () => {
    vi.mocked(putPlaylistTracks).mockResolvedValue(new Response(null, { status: 403 }));
    const p = props();
    const { result } = renderHook(() => usePlaylistEditing(p));
    await act(async () => { expect(await result.current.updatePlaylistTracks(next)).toBe(false); });
    expect(p.setPlaylistTracks.mock.calls.map(call => call[0])).toEqual([next, tracks]);
    expect(p.showError).toHaveBeenCalledWith("Esa playlist es de otra cuenta del nido. Haz una copia con otro nombre.");
  });
  it("rolls back a network failure and leaves a newly opened playlist alone", async () => {
    let reject: (error: Error) => void;
    vi.mocked(putPlaylistTracks).mockReturnValue(new Promise((_, r) => { reject = r; }));
    const p = props();
    const { result, rerender } = renderHook(({ name }) => usePlaylistEditing({ ...p, selectedPlaylistName: name }), { initialProps: { name: "Example" } });
    let saving: Promise<boolean>;
    act(() => { saving = result.current.updatePlaylistTracks(next); });
    rerender({ name: "Other" });
    await act(async () => { reject(new Error("Network unavailable")); await saving; });
    expect(p.setPlaylistTracks).toHaveBeenCalledExactlyOnceWith(next);
    expect(p.showError).toHaveBeenCalledWith("Network unavailable");
  });
});
