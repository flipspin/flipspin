import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { installFakeBackend, type FakeBackend } from "../data/test-support";
import { matchesLyricFilter, refreshLyricStates, useLyricStates } from "./lyricStates";
let backend: FakeBackend | undefined;
afterEach(() => { cleanup(); backend?.restore(); });
const counts = { synced: 1, plain: 0, pending: 0, none: 0, instrumental: 0, queued: 0 };
function Reader() { const data = useLyricStates(); return <output>{Object.keys(data.states).join(",")}</output>; }
it("reuses ETags, accepts 304, and drops cached rows when the identity changes", async () => {
  let member = false;
  backend = installFakeBackend({ respond: (req) => req.headers["if-none-match"] ? { status: 304 } : { status: 200, json: { states: member ? { "Mine/two.mp3": "synced" } : { "Owner/one.mp3": "synced" }, counts } } });
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => { const response = await fetch(input, init); response.headers.set("ETag", '"lyrics-1"'); return response; };
  render(<Reader />);
  await screen.findByText("Owner/one.mp3");
  await act(() => refreshLyricStates());
  expect(backend.requests.at(-1)?.headers["if-none-match"]).toBe('"lyrics-1"');
  expect(screen.getByRole("status")).toHaveTextContent("Owner/one.mp3");
  member = true;
  act(() => backend?.emitAuthChanged());
  expect(screen.queryByText("Owner/one.mp3")).toBeNull();
  await screen.findByText("Mine/two.mp3");
  expect(backend.requests.at(-1)?.headers["if-none-match"]).toBeUndefined();
});
it("ignores a response started under an earlier account", async () => {
  let finish: (() => void) | undefined; let requests = 0;
  backend = installFakeBackend({ respond: async () => {
    if (++requests === 1) { await new Promise<void>((resolve) => { finish = resolve; }); return { status: 200, json: { states: { "Foreign/one.mp3": "plain" }, counts } }; }
    return { status: 200, json: { states: { "Mine/two.mp3": "synced" }, counts } };
  } });
  render(<Reader />);
  await waitFor(() => expect(finish).toBeDefined());
  act(() => backend?.emitAuthChanged());
  await screen.findByText("Mine/two.mp3");
  await act(async () => { finish?.(); });
  expect(screen.queryByText("Foreign/one.mp3")).toBeNull();
});
it("groups known absences together and leaves unknown jobs out of both categories", () => {
  expect(matchesLyricFilter("instrumental", "without")).toBe(true);
  expect(matchesLyricFilter("none", "without")).toBe(true);
  expect(matchesLyricFilter("pending", "without")).toBe(true);
  expect(matchesLyricFilter("plain", "with")).toBe(true);
  expect(matchesLyricFilter("synced", "with")).toBe(true);
  expect(matchesLyricFilter("queued", "without")).toBe(false);
  expect(matchesLyricFilter(null, "with")).toBe(false);
  expect(matchesLyricFilter(null, "without")).toBe(false);
  expect(matchesLyricFilter(null, "all")).toBe(true);
});

it("keeps a queued song in its known filter category until its result arrives", async () => {
  let state = "pending";
  backend = installFakeBackend({ respond: () => ({ status: 200, json: {
    states: { "Album/one.mp3": state },
    counts: { synced: 0, plain: 0, pending: 0, none: 0, instrumental: 0, queued: 0, [state]: 1 },
  } }) });
  const { result } = renderHook(useLyricStates);
  await waitFor(() => expect(result.current.filterStates["Album/one.mp3"]).toBe("pending"));
  state = "queued";
  await act(() => refreshLyricStates());
  expect(result.current.states["Album/one.mp3"]).toBe("queued");
  expect(result.current.filterStates["Album/one.mp3"]).toBe("pending");
  expect(result.current.filterCounts.pending).toBe(1);
  state = "synced";
  await act(() => refreshLyricStates());
  expect(result.current.filterStates["Album/one.mp3"]).toBe("synced");
  expect(result.current.filterCounts.pending).toBe(0);
});
