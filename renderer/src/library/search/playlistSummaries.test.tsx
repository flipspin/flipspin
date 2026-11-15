import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("@lib/api", () => ({ backendRequest: request }));
import { setApiToken } from "@lib/authToken";
import { fetchPlaylistSummaries, usePlaylistSummaries } from "@lib/playlistSummaries";

let account = 0;
beforeEach(() => { setApiToken(`account-${++account}`); request.mockReset(); });
afterEach(() => vi.restoreAllMocks());
const response = (names: string[]) => ({ ok: true, body: JSON.stringify(names.map(name => ({ name }))) });

it("reads only the shell's access-filtered summaries without fetching on mount or rerender", async () => {
  const view = renderHook(() => usePlaylistSummaries());
  expect(view.result.current).toEqual([]);
  expect(request).not.toHaveBeenCalled();
  request.mockResolvedValueOnce(response(["My list", "Shared with me"]));
  await act(async () => { await fetchPlaylistSummaries(); });
  expect(view.result.current.map((item: { name: string }) => item.name)).toEqual(["My list", "Shared with me"]);
  view.rerender();
  expect(request).toHaveBeenCalledTimes(1);
  request.mockResolvedValueOnce(response(["My list"]));
  await act(async () => { await fetchPlaylistSummaries({ force: true }); });
  expect(view.result.current).toEqual([{ name: "My list" }]);
  act(() => { setApiToken("another-account"); });
  expect(view.result.current).toEqual([]);
  expect(request).toHaveBeenCalledTimes(2);
});

it("discards a previous account's in-flight list after the account changes", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  request.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const view = renderHook(() => usePlaylistSummaries());
  const previous = fetchPlaylistSummaries();
  act(() => { setApiToken("next-account"); });
  finish(response(["Private to previous account"]));
  await expect(previous).rejects.toThrow("account-changed");
  expect(view.result.current).toEqual([]);
  request.mockResolvedValueOnce(response(["Visible to next account"]));
  await act(async () => { await fetchPlaylistSummaries(); });
  expect(view.result.current).toEqual([{ name: "Visible to next account" }]);
});

it("coalesces sibling refreshes and never returns an older snapshot over a live summary", async () => {
  const view = renderHook(() => usePlaylistSummaries());
  request.mockResolvedValueOnce({ ...response(["Saved while offline"]), headers: { "x-krobi-snapshot-at": "1" } });
  await act(async () => { await fetchPlaylistSummaries(); });
  expect(view.result.current).toEqual([{ name: "Saved while offline" }]);
  request.mockResolvedValueOnce(response(["Live flat album keys"]));
  await act(async () => {
    const first = fetchPlaylistSummaries({ force: true });
    expect(fetchPlaylistSummaries()).toBe(first);
    await first;
  });
  request.mockResolvedValueOnce({ ...response(["Old nested album keys"]), headers: { "x-krobi-snapshot-at": "1" } });
  await act(async () => {
    expect(await fetchPlaylistSummaries({ force: true })).toEqual([{ name: "Live flat album keys" }]);
  });
  expect(view.result.current).toEqual([{ name: "Live flat album keys" }]);
  expect(request).toHaveBeenCalledTimes(3);
});

it("retains a live result received after the saved copy was fetched", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  let finish!: (value: ReturnType<typeof response>) => void;
  request.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const live = fetchPlaylistSummaries();
  now.mockReturnValue(3000);
  finish(response(["Latest live summary"]));
  await live;
  request.mockResolvedValueOnce({ ...response(["Saved during the live request"]), headers: { "x-krobi-snapshot-at": "2" } });
  expect(await fetchPlaylistSummaries({ force: true })).toEqual([{ name: "Latest live summary" }]);
});


it("forces a new request during an older read and keeps the refreshed list when the old read finishes last", async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  request.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  request.mockResolvedValueOnce(response(["Newly created playlist"]));
  const view = renderHook(() => usePlaylistSummaries());
  const old = fetchPlaylistSummaries();
  const refreshed = fetchPlaylistSummaries({ force: true });
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => { await refreshed; });
  expect(view.result.current).toEqual([{ name: "Newly created playlist" }]);
  finish(response(["Old list"]));
  expect(await old).toEqual([{ name: "Newly created playlist" }]);
  expect(view.result.current).toEqual([{ name: "Newly created playlist" }]);
});


it("keeps the forced request in flight when an older request finishes first", async () => {
  let finishOld!: (value: ReturnType<typeof response>) => void;
  let finishNew!: (value: ReturnType<typeof response>) => void;
  request.mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }));
  request.mockReturnValueOnce(new Promise(resolve => { finishNew = resolve; }));
  const old = fetchPlaylistSummaries();
  const refreshed = fetchPlaylistSummaries({ force: true });
  finishOld(response(["Stale list"]));
  await Promise.resolve();
  expect(fetchPlaylistSummaries()).toBe(refreshed);
  finishNew(response(["Current list"]));
  expect(await old).toEqual([{ name: "Current list" }]);
  expect(await refreshed).toEqual([{ name: "Current list" }]);
  expect(request).toHaveBeenCalledTimes(2);
});
