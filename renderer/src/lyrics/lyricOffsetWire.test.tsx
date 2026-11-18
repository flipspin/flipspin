import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { installFakeBackend, type FakeBackend } from "../data/test-support";
import { loadLyrics, type LyricsDoc } from "./lyricsStore";
import { setLyricsOffset } from "./lrc";
import { __resetOffsetsForTest, flushLyricOffsets, useLyricOffset } from "./useLyricOffset";

let backend: FakeBackend | undefined;
afterEach(() => { __resetOffsetsForTest(); backend?.restore(); vi.useRealTimers(); });

it("flushes through the real HTTP client on close before 300 ms, then reloads the stored total", async () => {
  vi.useFakeTimers();
  const path = "Wire/Song.mp3";
  let server: LyricsDoc = { relPath: path, kind: "synced", text: "[offset:+500]\n[00:00.20]Early\n",
    offsetMs: 500, source: "lrclib", edited: false, fetchedAt: 1, revision: "r1" };
  backend = installFakeBackend({ respond: request => request.pathname.startsWith("/api/lyrics/")
    ? { status: 200, json: server } : undefined });
  const network = globalThis.fetch;
  let write: Request | undefined;
  globalThis.fetch = (async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === "PUT") {
      write = request;
      expect(new URL(request.url).pathname).toBe("/api/lyrics/Wire/Song.mp3/offset");
      const body = await request.clone().json();
      expect(body).toEqual({ offsetMs: 600, expectedRevision: "r1" });
      server = { ...server, offsetMs: body.offsetMs, text: setLyricsOffset(server.text, body.offsetMs), revision: "r2" };
    }
    return network(input, init);
  }) as typeof fetch;
  function Window({ doc }: { doc: LyricsDoc }) {
    const sync = useLyricOffset(path, doc, true, false);
    return <><output aria-label="total">{sync.shown}</output><button onClick={() => sync.nudge(0.1)}>Sooner</button></>;
  }
  const view = render(<Window doc={server} />);
  fireEvent.click(screen.getByText("Sooner"));
  expect(write).toBeUndefined();
  view.unmount();
  await act(async () => { await flushLyricOffsets(); });
  expect(write?.keepalive).toBe(true);
  expect(server.text).toBe("[offset:+600]\n[00:00.20]Early\n");
  __resetOffsetsForTest();
  const reloaded = await loadLyrics(path, { force: true });
  render(<Window doc={reloaded!} />);
  expect(screen.getByLabelText("total")).toHaveTextContent("0.6");
});
