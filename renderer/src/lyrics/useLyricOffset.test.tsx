import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readLyricsOffset, setLyricsOffset, parseLyrics } from "./lrc";
import type { LyricsDoc } from "./lyricsStore";
const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock("./lyricsStore", () => ({ saveLyricsOffset: save }));
import { __resetOffsetsForTest, useLyricOffset } from "./useLyricOffset";
let server: LyricsDoc;
function Surface({ name, doc = server, path = "Album/Song.mp3", preview = false }: { name: string; doc?: LyricsDoc; path?: string; preview?: boolean }) {
  const sync = useLyricOffset(path, preview ? null : doc, true, false, preview ? doc.text : path, doc.text);
  return <div><output aria-label={name}>{sync.shown}:{sync.saveState}</output>
    <button onClick={() => sync.nudge(0.1)}>{name} sooner</button>
    <button onClick={sync.reset}>{name} reset</button></div>;
}
beforeEach(() => {
  vi.useFakeTimers();
  server = { relPath: "Album/Song.mp3", kind: "synced", text: "[offset:+500]\n[00:00.20]Early\n[00:02.00]Later\n", offsetMs: 500,
    source: "lrclib", fetchedAt: 1, edited: false, revision: "r1" };
  save.mockReset().mockImplementation(async (_path, offsetMs, doc) => {
    expect(doc.revision).toBe(server.revision);
    server = { ...server, text: setLyricsOffset(server.text, offsetMs), offsetMs, revision: `${server.revision}x` };
    return server;
  });
});
afterEach(() => { __resetOffsetsForTest(); vi.useRealTimers(); });
it("flushes a nudge on close before 300 ms; reopening shows the saved total", async () => {
  const view = render(<Surface name="window" />);
  fireEvent.click(screen.getByText("window sooner"));
  expect(save).not.toHaveBeenCalled();
  view.unmount();
  await act(async () => {});
  expect(readLyricsOffset(server.text)).toBe(600);
  expect(server.text).toContain("[00:00.20]Early");
  render(<Surface name="window" />);
  expect(screen.getByLabelText("window")).toHaveTextContent("0.6:saved");
});
it("window and overlay read the same total and reset the saved correction to zero", async () => {
  render(<><Surface name="window" /><Surface name="overlay" /></>);
  fireEvent.click(screen.getByText("window sooner"));
  expect(screen.getByLabelText("overlay")).toHaveTextContent("0.6");
  fireEvent.click(screen.getByText("overlay reset"));
  expect(screen.getByLabelText("window")).toHaveTextContent("0:");
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(server.offsetMs).toBe(0);
  expect(parseLyrics(server.text)[0].time).toBe(0.2);
});
it.each(["pagehide", "hidden"])("flushes on %s", async event => {
  render(<Surface name="window" />);
  fireEvent.click(screen.getByText("window sooner"));
  if (event === "pagehide") fireEvent(window, new Event("pagehide"));
  else { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); fireEvent(document, new Event("visibilitychange")); }
  await act(async () => {});
  expect(server.offsetMs).toBe(600);
});
it("flushes the old song when switching songs", async () => {
  const view = render(<Surface name="window" />);
  fireEvent.click(screen.getByText("window sooner"));
  view.rerender(<Surface name="window" path="Album/Next.mp3" doc={{ ...server, relPath: "Album/Next.mp3", text: "[00:01]Next", offsetMs: 0 }} />);
  await act(async () => {});
  expect(save).toHaveBeenCalledWith("Album/Song.mp3", 600, expect.anything());
  expect(screen.getByLabelText("window")).toHaveTextContent("0:idle");
});
it("keeps failed values visible and retries on the next change", async () => {
  save.mockRejectedValueOnce(new Error("offline"));
  render(<Surface name="window" />);
  fireEvent.click(screen.getByText("window sooner"));
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(screen.getByLabelText("window")).toHaveTextContent("0.6:error");
  fireEvent.click(screen.getByText("window sooner"));
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(server.offsetMs).toBe(700);
});
it("keeps a non-current preview local and isolated from the current song", async () => {
  render(<><Surface name="preview" preview /><Surface name="overlay" /></>);
  fireEvent.click(screen.getByText("preview sooner"));
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(screen.getByLabelText("preview")).toHaveTextContent("0.6");
  expect(screen.getByLabelText("overlay")).toHaveTextContent("0.5");
  expect(save).not.toHaveBeenCalled();
});
