import { clockUser } from '../test/test-clock';
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LyricsCandidate, LyricsDoc, LyricsEngine } from "./lyricsStore";
import i18n from "../i18n";

const mocks = vi.hoisted(() => ({
  doc: null as LyricsDoc | null, engine: null as LyricsEngine | null,
  localEnabled: false,
  searchLyrics: vi.fn(), loadLyrics: vi.fn(), saveLyrics: vi.fn(), saveLyricsOffset: vi.fn(),
  alignLyrics: vi.fn(), jobProgress: vi.fn(), cancelEngineRun: vi.fn(), deleteLyrics: vi.fn(), refreshJobs: vi.fn(),
  player: { audioRef: { current: null as HTMLAudioElement | null }, nowPlaying: null as { path: string } | null, isPlaying: false, setIsPlaying: vi.fn(), play: vi.fn() },
}));
vi.mock("./lyricsStore", async importOriginal => ({
  ...await importOriginal<typeof import("./lyricsStore")>(), ...mocks,
  useLyricsFor: () => ({ doc: mocks.doc, known: true }),
  useLocalLyricsEnabled: () => mocks.localEnabled, useLocalLyricsStatus: () => null,
  useLyricsJobs: () => ({ engine: mocks.engine, providers: ["lrclib", "genius", "lyricsovh"] }), watchJobs: () => () => {},
}));
vi.mock("@state/AudioPlayerContext", () => ({ useAudioPlayer: () => mocks.player }));
vi.mock("./macEngine", () => ({ refreshMac: vi.fn(), useMacEngine: () => ({ available: true, status: null, lastError: null }) }));
vi.mock("../settings/background/data", async original => ({
  ...await original<typeof import("../settings/background/data")>(), useCompute: () => ({ data: undefined, isError: false }),
}));
import LyricsModal from "./LyricsModal";
import { readLyricsOffset, setLyricsOffset } from "./lrc";
import { __resetOffsetsForTest } from "./useLyricOffset";
import { __resetSyncRunsForTest } from "./syncRunStore";
import { ApiError } from "../data";

const candidate: LyricsCandidate = {
  provider: "lrclib", providerRef: "lrclib:42", title: "Song", artist: "Artist", album: "Album",
  durationSeconds: 166, durationDeltaSeconds: 0, overrunSeconds: 0, kind: "synced", withinTolerance: true,
  instrumental: false, lineCount: 2, preview: ["Catalog words"], text: "[00:03]Catalog words\n[00:05]Last line",
};
const document = (overrides: Partial<LyricsDoc> = {}): LyricsDoc => ({
  relPath: "Album/Song.mp3", kind: "synced", text: "[00:01]Current words", source: "lrclib",
  fetchedAt: 1, edited: false, revision: "revision-1", offsetMs: readLyricsOffset(overrides.text), ...overrides,
});
const props = { open: true, relPath: "Album/Song.mp3", track: { title: "Song", artist: "Artist", duration: 166 }, onClose: vi.fn() };
const mount = () => render(<LyricsModal {...props} />);
const button = (name: string | RegExp) => screen.getByRole("button", { name });
const versionRows = () => Array.from(window.document.querySelectorAll<HTMLButtonElement>(".lyrics-version"));
const currentRow = () => versionRows().find(row => row.getAttribute("aria-current") === "true")!;
const previewCatalog = async (name = "LRCLIB") => {
  await waitFor(() => expect(versionRows().find(row => !row.hasAttribute("aria-current") && row.textContent?.startsWith(name))).toBeDefined());
  await userEvent.click(versionRows().find(row => !row.hasAttribute("aria-current") && row.textContent?.startsWith(name))!);
};
const usePreview = async () => userEvent.click(button(/^Use (these lyrics|as is|untimed lyrics)$/));

beforeEach(async () => {
  vi.clearAllMocks(); await i18n.changeLanguage("en");
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.doc = document(); mocks.localEnabled = false; mocks.player = { audioRef: { current: null }, nowPlaying: null, isPlaying: false, setIsPlaying: vi.fn(), play: vi.fn() };
  mocks.engine = { ready: true, mode: "local", version: "0.12.0", running: null } as LyricsEngine;
  mocks.searchLyrics.mockResolvedValue({ query: {}, providers: ["lrclib", "genius", "lyricsovh"], candidates: [candidate] });
  mocks.loadLyrics.mockImplementation(async () => mocks.doc);
  mocks.saveLyrics.mockImplementation(async (_rel, payload) => { mocks.doc = document({ ...payload, revision: "revision-2" }); return mocks.doc; });
  mocks.saveLyricsOffset.mockImplementation(async (_rel, offsetMs, doc) => {
    mocks.doc = { ...doc, text: setLyricsOffset(doc.text, offsetMs), offsetMs, revision: "revision-2" }; return mocks.doc;
  });
  mocks.deleteLyrics.mockImplementation(async () => { mocks.doc = null; });
  mocks.alignLyrics.mockResolvedValue({ progressId: "align-1", total: 1 });
  mocks.cancelEngineRun.mockResolvedValue(true);
  mocks.jobProgress.mockResolvedValue({ terminal: false, active: { Song: { phase: "alineando", percent: 30 } } });
});
afterEach(async () => { __resetSyncRunsForTest(); __resetOffsetsForTest(); vi.restoreAllMocks(); vi.useRealTimers(); await i18n.changeLanguage("es"); });

it("forces a saved-lyrics check when opening the editor or search", async () => {
  mount();
  await waitFor(() => expect(mocks.loadLyrics).toHaveBeenCalledWith(props.relPath, { force: true }));
});

it("searches with five skeleton lines, previews the top result, then saves directly with Undo", async () => {
  mocks.doc = null;
  let resolve!: (value: unknown) => void;
  mocks.searchLyrics.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  mount();
  expect(screen.getByRole("status")).toHaveTextContent("Searching…");
  expect(screen.getByLabelText("Searching…").children).toHaveLength(5);
  await act(async () => resolve({ candidates: [candidate] }));
  expect(screen.getByText("Catalog words")).toBeVisible();
  expect(button("Edit")).toBeVisible(); expect(mocks.saveLyrics).not.toHaveBeenCalled();
  await usePreview();
  expect(mocks.saveLyrics).toHaveBeenCalledWith(props.relPath, expect.objectContaining({ source: "lrclib", force: false, expectedRevision: "" }));
  expect(await screen.findByText("Now using LRCLIB")).toBeVisible(); expect(button("Undo")).toBeVisible();
  expect(currentRow()).toHaveTextContent("LRCLIB Current"); expect(screen.queryByText("Lose your edits?")).toBeNull();
});

it("shows a saved synced lyric with a single sidebar re-sync action", async () => {
  mount(); expect(screen.getByRole("status")).toHaveTextContent("Synced");
  expect(currentRow()).toHaveTextContent("LRCLIB Current");
  expect(screen.queryByRole("button", { name: "Use these lyrics" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Sync with Flipspin" })).toBeNull();
  expect(screen.getAllByRole("button", { name: "Re-sync with Flipspin" })).toHaveLength(1);
  await waitFor(() => expect(mocks.searchLyrics).toHaveBeenCalledWith(props.relPath, {}));
});

it("previews a version row without a PUT and keeps the current row first", async () => {
  mount(); await screen.findByText("Album · 2:46 · 2 lines");
  const items = versionRows();
  expect(items[0]).toHaveTextContent("✓LRCLIB Current"); expect(items[0]).toHaveTextContent("Synced");
  expect(screen.getByText("VERSIONS")).toBeVisible();
  await userEvent.click(items[1]);
  expect(screen.getByText("Catalog words")).toBeVisible(); expect(mocks.saveLyrics).not.toHaveBeenCalled();
  await usePreview(); expect(mocks.saveLyrics).toHaveBeenCalledTimes(1);
});

it("names the catalog version with the same album and length as the list detail and a full title", async () => {
  const album = "A very long album title that distinguishes this recording from the other versions";
  mocks.searchLyrics.mockResolvedValue({ candidates: [{ ...candidate, album, durationSeconds: 234 }] });
  mount(); await screen.findByText(/2 lines/);
  expect(screen.getByText(`${album} · 3:54 · 2 lines`)).toBeVisible();
  await userEvent.click(versionRows()[1]);
  expect(versionRows()[1]).toHaveAttribute("aria-pressed", "true");
  expect(versionRows()[1]).toHaveAttribute("title", `LRCLIB · ${album} · 3:54 · 2 lines`);
});

it("uses the artist when the catalog has no album", async () => {
  mocks.doc = null;
  mocks.searchLyrics.mockResolvedValue({ candidates: [{ ...candidate, album: "" }] });
  mount();
  expect(await screen.findByRole("button", { name: /LRCLIB.*Artist · 2:46 · 2 lines/ })).toHaveAttribute("title", "LRCLIB · Artist · 2:46 · 2 lines");
});

it.each(["record", "result"])("includes saved version metadata from the %s when present", location => {
  const metadata = { album: "Saved album", durationSeconds: 234 };
  mocks.doc = location === "record" ? { ...document(), ...metadata } : document({ result: metadata });
  mount();
  expect(currentRow()).toHaveAttribute("title", "LRCLIB · Saved album · 3:54 · 1 line");
});

it("nudges playback live, then saves the tag once after the pause without scrolling the page", async () => {
  const audio = documentAudio(); audio.currentTime = 0.95;
  mocks.player = { audioRef: { current: audio }, nowPlaying: { path: props.relPath }, isPlaying: true, setIsPlaying: vi.fn(), play: vi.fn() };
  const scroll = vi.fn();
  const previousScroll = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = scroll;
  try {
    vi.useFakeTimers(); mount();
    await act(async () => {});
    const line = screen.getByText("Current words");
    expect(line).not.toHaveAttribute("aria-current");
    fireEvent.click(button("Advance"));
    expect(screen.getByRole("textbox", { name: "Offset in seconds" })).toHaveValue("+0.1");
    expect(line).toHaveAttribute("aria-current", "true");
    expect(mocks.saveLyricsOffset).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(301));
    expect(mocks.saveLyricsOffset).toHaveBeenCalledExactlyOnceWith(props.relPath, 100, expect.objectContaining({ revision: "revision-1" }));
    expect(line).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("textbox", { name: "Offset in seconds" })).toHaveValue("+0.1");
    await act(() => vi.advanceTimersByTimeAsync(301));
    expect(mocks.saveLyricsOffset).toHaveBeenCalledTimes(1);
    expect(scroll).not.toHaveBeenCalled();
  } finally { Element.prototype.scrollIntoView = previousScroll; }
});

it.each([true, false])("keeps catalog nudges in memory until Use saves the offset tag (fitting=%s)", async fitting => {
  mocks.searchLyrics.mockResolvedValue({ candidates: [{ ...candidate, withinTolerance: fitting, durationDeltaSeconds: fitting ? 0 : 11, durationSeconds: fitting ? 166 : 177 }] });
  const audio = documentAudio(); audio.currentTime = 2.85;
  mocks.player = { audioRef: { current: audio }, nowPlaying: { path: props.relPath }, isPlaying: false, setIsPlaying: vi.fn(), play: vi.fn() };
  mount(); await previewCatalog();
  expect(screen.getByText("Catalog words")).not.toHaveAttribute("aria-current");
  vi.useFakeTimers();
  fireEvent.click(button("Advance")); fireEvent.click(button("Advance"));
  expect(screen.getByRole("textbox", { name: "Offset in seconds" })).toHaveValue("+0.2");
  expect(screen.getByText("Catalog words")).toHaveAttribute("aria-current", "true");
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(mocks.saveLyrics).not.toHaveBeenCalled();
  fireEvent.click(button(/^Use (these lyrics|as is|untimed lyrics)$/)); await act(async () => {});
  expect(mocks.saveLyrics).toHaveBeenCalledExactlyOnceWith(props.relPath, expect.objectContaining({
    kind: "synced", text: "[offset:+200]\n[00:03]Catalog words\n[00:05]Last line",
  }));
  expect(screen.getByRole("textbox", { name: "Offset in seconds" })).toHaveValue("+0.2");
});

it.each([false, true])("resets the nudge when switching results or returning to the saved lyric (local=%s)", async local => {
  mocks.localEnabled = local;
  mocks.searchLyrics.mockResolvedValue({ candidates: [candidate, { ...candidate, providerRef: "lrclib:43", album: "Other album", text: "[00:04]Other words" }] });
  mount(); await previewCatalog();
  await userEvent.click(button("Advance")); await userEvent.click(button("Advance"));
  await userEvent.click(button(/Other album/));
  expect(screen.getByRole("textbox", { name: "Offset in seconds" })).toHaveValue("0.0");
  await userEvent.click(button("Advance"));
  await userEvent.click(currentRow());
  expect(screen.getByRole("textbox", { name: "Offset in seconds" })).toHaveValue("0.0");
  expect(mocks.saveLyrics).not.toHaveBeenCalled();
});

it("keeps an in-flight saved adjustment from changing the next catalog preview's nudge", async () => {
  let finish!: () => void;
  mocks.saveLyricsOffset.mockImplementationOnce((_path, offsetMs, doc) => new Promise<LyricsDoc>(resolve => {
    finish = () => { mocks.doc = { ...doc, text: setLyricsOffset(doc.text, offsetMs), offsetMs, revision: "revision-2" }; resolve(mocks.doc); };
  }));
  mount(); await waitFor(() => expect(mocks.searchLyrics).toHaveBeenCalled());
  vi.useFakeTimers();
  fireEvent.click(button("Advance"));
  await act(() => vi.advanceTimersByTimeAsync(301));
  expect(mocks.saveLyricsOffset).toHaveBeenCalledTimes(1);
  fireEvent.click(versionRows()[1]);
  fireEvent.click(button("Advance")); fireEvent.click(button("Advance"));
  await act(async () => finish());
  expect(screen.getByText("Catalog words")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Offset in seconds" })).toHaveValue("+0.2");
  expect(mocks.saveLyricsOffset).toHaveBeenCalledTimes(1);
});

it("hides the nudge for plain lyrics and while editing synced lyrics", async () => {
  mocks.doc = document({ kind: "plain", text: "Words" });
  mount(); expect(screen.queryByRole("button", { name: "Advance" })).toBeNull();
  await previewCatalog(); expect(button("Advance")).toBeVisible();
  await userEvent.click(button("Edit"));
  expect(screen.queryByRole("button", { name: "Advance" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "Lyric text" })).toBeVisible();
});

it("syncs the saved plain lyric only on request, displays progress, then Synced", async () => {
  // Drive the progress poll explicitly; CPU scheduling must not choose its deadline.
  vi.useFakeTimers();
  mocks.doc = document({ kind: "plain", text: "First\n\nLast", source: "genius", edited: true }); const view = mount();
  await act(async () => { fireEvent.click(button("Sync with Flipspin")); });
  expect(mocks.alignLyrics).toHaveBeenCalledWith(props.relPath, expect.objectContaining({ text: "First\n\nLast", source: "genius", edited: true, force: true }));
  expect(screen.getByRole("status")).toHaveTextContent("Syncing · 30 %");
  expect(within(currentRow()).getByText("Syncing")).toBeVisible();
  await act(() => i18n.changeLanguage("es"));
  expect(within(currentRow()).getByText("Sincronizando")).toBeVisible();
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "30");
  expect(screen.queryByRole("button", { name: "Advance" })).toBeNull();
  mocks.doc = document(); view.rerender(<LyricsModal {...props} />);
  expect(screen.queryByRole("button", { name: "Advance" })).toBeNull();
  expect(button("Edit text")).toBeDisabled(); expect(button("Delete lyrics")).toBeDisabled();
  mocks.doc = document({ source: "genius" }); mocks.jobProgress.mockResolvedValue({ terminal: true, succeeded: 1 });
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(screen.getByRole("status")).toHaveTextContent(/^Synced$/);
  expect(mocks.saveLyrics).not.toHaveBeenCalled();
});

it("shows a short sync failure with a title and retries without exposing raw diagnostics", async () => {
  mocks.doc = document({ kind: "plain", text: "Words" });
  const detail = "POST /api/lyrics/align → 404 ValueError: CTC failed";
  mocks.alignLyrics.mockRejectedValueOnce(new Error(detail)); mount();
  await userEvent.click(button("Sync with Flipspin"));
  expect(screen.getByRole("status")).toHaveTextContent("Couldn’t sync");
  expect(screen.getByRole("status")).toHaveAttribute("title", detail);
  expect(screen.queryByText(detail)).toBeNull(); expect(console.error).toHaveBeenCalled();
  await userEvent.click(button("Sync with Flipspin")); expect(mocks.alignLyrics).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status")).toHaveTextContent("Syncing");
});

it("handles a terminal failure and cancels a running job", async () => {
  mocks.doc = document({ kind: "plain", text: "Words" });
  mocks.jobProgress.mockResolvedValueOnce({ terminal: true, succeeded: 0, failures: [{ reason: "CTC failed" }] });
  mount(); await userEvent.click(button("Sync with Flipspin"));
  expect(button("Sync with Flipspin")).toBeVisible(); await userEvent.click(button("Sync with Flipspin"));
  await userEvent.click(button("Cancel"));
  expect(mocks.cancelEngineRun).toHaveBeenCalledWith("align-1");
  await waitFor(() => expect(button("Sync with Flipspin")).toBeVisible());
});

it("links a saved plain lyric without an engine to Settings Engines", async () => {
  mocks.doc = document({ kind: "plain", text: "Words" }); mocks.engine = null;
  const listener = vi.fn(); window.addEventListener("krobi-show-settings", listener); mount();
  const link = button("Sync with Flipspin Add-on");
  expect(link).toHaveAttribute("title", "Needs the Lyrics add-on · opens Settings → Engines");
  await userEvent.click(link); expect(listener.mock.calls[0][0].detail).toEqual({ section: "complementos" });
  window.removeEventListener("krobi-show-settings", listener);
});

it.each([false, true])("saves plain catalog words before offering sync, with ready engine=%s", async ready => {
  if (!ready) mocks.engine = null;
  mocks.searchLyrics.mockResolvedValue({ candidates: [{ ...candidate, provider: "genius", kind: "plain", text: "Words" }] });
  mount(); await previewCatalog("Genius"); await usePreview();
  expect(mocks.saveLyrics).toHaveBeenCalledWith(props.relPath, expect.objectContaining({ kind: "plain", source: "genius", text: "Words" }));
  expect(mocks.alignLyrics).not.toHaveBeenCalled();
  expect(button(ready ? "Sync with Flipspin" : "Sync with Flipspin Add-on")).toBeVisible();
});

it("asks once inside the footer before replacing edits and Keep mine sends nothing", async () => {
  mocks.doc = document({ edited: true }); mount(); await previewCatalog(); await usePreview();
  expect(mocks.saveLyrics).not.toHaveBeenCalled();
  expect(screen.getByText("Lose your edits?").closest(".lyrics-footer-actions")).not.toBeNull();
  await userEvent.click(button("Keep mine")); expect(mocks.saveLyrics).not.toHaveBeenCalled();
  await usePreview(); await userEvent.click(button("Use LRCLIB"));
  expect(mocks.saveLyrics).toHaveBeenCalledWith(props.relPath, expect.objectContaining({ force: true }));
});

it.each([true, false])("edits the current text, preserves its source and marks it edited (previous lock=%s)", async edited => {
  mocks.doc = document({ edited, source: "genius" }); mount();
  await userEvent.click(button("Edit text"));
  const textarea = screen.getByRole("textbox", { name: "Lyric text" });
  fireEvent.change(textarea, { target: { value: "[00:01]Corrected words" } }); await userEvent.click(button("Save"));
  expect(mocks.saveLyrics).toHaveBeenCalledWith(props.relPath, expect.objectContaining({ text: "[00:01]Corrected words", source: "genius", edited: true, force: edited }));
  expect(screen.getByRole("status")).toHaveTextContent("Synced");
  expect(currentRow()).toHaveTextContent("Genius Current"); expect(screen.queryByText("Lose your edits?")).toBeNull();
});

it("editing a catalog preview asks before replacing edited current words", async () => {
  mocks.doc = document({ edited: true }); mount(); await previewCatalog(); await userEvent.click(button("Edit"));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "New edited words" } });
  await userEvent.click(button("Save")); expect(mocks.saveLyrics).not.toHaveBeenCalled();
  await userEvent.click(button("Use LRCLIB"));
  expect(mocks.saveLyrics).toHaveBeenCalledWith(props.relPath, expect.objectContaining({ edited: true, force: true, text: "New edited words" }));
});

it("shows no results with Paste/Open and a catalog tooltip, and paste has one Save", async () => {
  mocks.doc = null; mocks.searchLyrics.mockResolvedValue({ providers: ["lrclib", "genius", "lyricsovh"], candidates: [] }); mount();
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No lyrics found"));
  expect(screen.getByRole("status")).toHaveAttribute("title", "LRCLIB, Genius, Lyrics.ovh");
  expect(button("Open file…")).toBeVisible(); await userEvent.click(button("Paste your own…"));
  expect(screen.getByRole("textbox")).toHaveValue("");
  expect(screen.getAllByRole("button", { name: /^Save/ })).toHaveLength(1);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Own words" } }); await userEvent.click(button("Save"));
  expect(mocks.saveLyrics).toHaveBeenCalledWith(props.relPath, expect.objectContaining({ kind: "plain", source: "manual", edited: true }));
  expect(currentRow()).toHaveTextContent("Your text Current"); expect(mocks.alignLyrics).not.toHaveBeenCalled();
});

it("imports a file into a textarea and saves only when asked", async () => {
  mocks.doc = null; mocks.searchLyrics.mockResolvedValue({ candidates: [] }); mount();
  const file = new File(["[00:01]Imported"], "song.lrc", { type: "text/plain" });
  Object.defineProperty(file, "text", { value: async () => "[00:01]Imported" });
  await userEvent.upload(screen.getByLabelText("Import .txt or .lrc"), file);
  expect(screen.getByRole("textbox")).toHaveValue("[00:01]Imported"); expect(mocks.saveLyrics).not.toHaveBeenCalled();
  await userEvent.click(button("Save"));
  expect(mocks.saveLyrics).toHaveBeenCalledWith(props.relPath, expect.objectContaining({ kind: "synced", source: "file" }));
});

it("shows No vocals and only Paste in the footer for instrumental lyrics", async () => {
  mocks.doc = document({ kind: "instrumental", text: "" }); mount();
  expect(screen.getByText("No vocals")).toBeVisible(); expect(screen.getByRole("status")).toHaveTextContent("No vocals");
  expect(button("Paste your own…")).toBeVisible(); expect(screen.queryByRole("button", { name: "Delete lyrics" })).toBeNull();
});

it("warns on a catalog duration mismatch and preserves stamps when using as is", async () => {
  mocks.doc = null; mocks.searchLyrics.mockResolvedValue({ candidates: [{ ...candidate, durationSeconds: 177, durationDeltaSeconds: 11, withinTolerance: false }] }); mount();
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("For 2:57"));
  expect(screen.getByRole("status")).toHaveAttribute("title", "Timed for a 2:57 version; this song is 2:46");
  await usePreview();
  expect(mocks.saveLyrics).toHaveBeenCalledWith(props.relPath, expect.objectContaining({ kind: "synced", text: candidate.text }));
  expect(screen.getByRole("status")).toHaveTextContent("Synced");
});

it("Undo restores replaced words and all renderer-held record metadata", async () => {
  const before = document({ source: "genius", edited: true, fetchedAt: 42, result: { timingSource: "aligned:mms-fa" }, lineConfidence: [0.9], lowLines: [0] });
  mocks.doc = before; mount(); await previewCatalog(); await usePreview(); await userEvent.click(button("Use LRCLIB"));
  await userEvent.click(button("Undo"));
  expect(mocks.saveLyrics).toHaveBeenLastCalledWith(props.relPath, expect.objectContaining({
    kind: before.kind, text: before.text, source: before.source, edited: true, force: true, expectedRevision: "revision-2",
    restore: { fetchedAt: 42, title: before.title, artist: before.artist, result: before.result, lineConfidence: [0.9], lowLines: [0] },
  }));
});

it("Undo removes a newly saved lyric when there was no prior sidecar", async () => {
  mocks.doc = null; mount(); await screen.findByText("Catalog words"); await usePreview(); await userEvent.click(button("Undo"));
  await waitFor(() => expect(mocks.deleteLyrics).toHaveBeenCalledWith(props.relPath, "revision-2"));
});

it("follows the playing song's current line with the existing clock", async () => {
  const audio = documentAudio(); audio.currentTime = 2;
  mocks.player = { audioRef: { current: audio }, nowPlaying: { path: "Album/Song.mp3" }, isPlaying: false, setIsPlaying: vi.fn(), play: vi.fn() };
  mocks.doc = document({ text: "[00:01]First\n[00:03]Second" }); mount();
  expect(screen.getByText("First")).toHaveAttribute("aria-current", "true");
  act(() => { audio.currentTime = 4; audio.dispatchEvent(new Event("timeupdate")); });
  expect(screen.getByText("Second")).toHaveAttribute("aria-current", "true");
});
function documentAudio() { return window.document.createElement("audio"); }

it("retains the lyric during the exit animation and ignores a late search for another song", async () => {
  let resolve!: (value: unknown) => void;
  mocks.doc = null; mocks.searchLyrics.mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const view = mount(); view.rerender(<LyricsModal {...props} relPath="Other/Track.mp3" />);
  await screen.findByText("Catalog words"); await act(async () => resolve({ candidates: [] }));
  expect(screen.getByText("Catalog words")).toBeVisible();
  const panel = screen.getByRole("dialog"); panel.style.animationDuration = "140ms";
  view.rerender(<LyricsModal {...props} open={false} relPath={null} track={null} />);
  expect(panel).toHaveAttribute("data-state", "closed"); expect(screen.getByText("Catalog words")).toBeVisible();
  fireEvent.animationEnd(panel); expect(screen.queryByRole("dialog")).toBeNull();
});

it("honors catalog retryAfter and never exposes route diagnostics", async () => {
  mocks.doc = null; mocks.searchLyrics.mockRejectedValue(new ApiError({ kind: "http", status: 503, method: "POST", path: "/api/lyrics/search", message: "unavailable", body: { detail: "HTTP 429 catalog failure", retryAfter: 3 } }));
  mount(); await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No lyrics found"));
  await userEvent.click(button("Search again")); expect(mocks.searchLyrics).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/HTTP|429|503|\/api\//)).toBeNull();
});

it("uses persistent version buttons with arrow navigation and no dropdown", async () => {
  mount(); await screen.findByText("Album · 2:46 · 2 lines");
  expect(screen.queryByRole("menu")).toBeNull(); expect(screen.queryByRole("menuitem")).toBeNull();
  expect(window.document.querySelector('[aria-haspopup="menu"]')).toBeNull();
  expect(screen.queryByRole("tab")).toBeNull(); expect(screen.queryByRole("checkbox")).toBeNull(); expect(screen.queryByRole("combobox")).toBeNull();
  currentRow().focus(); await userEvent.keyboard("{ArrowDown}");
  expect(versionRows()[1]).toHaveFocus(); expect(versionRows()[1]).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByText("Catalog words")).toBeVisible();
  fireEvent.scroll(window.document.querySelector(".lyrics-preview-column")!);
  expect(versionRows()[1]).toBeVisible(); expect(screen.queryByRole("button", { name: "Re-sync with Flipspin" })).toBeNull();
  await userEvent.keyboard("{ArrowUp}"); expect(currentRow()).toHaveFocus(); expect(currentRow()).toHaveAttribute("aria-pressed", "true");
});

it("re-times edited current words from the sidebar and keeps their edit lock", async () => {
  mocks.doc = document({ edited: true, text: "[00:01]First\n\n[00:04]Corrected line" });
  mount();
  const action = button("Re-sync with Flipspin");
  expect(action).toBeVisible(); expect(action).not.toHaveClass("lyrics-engine-action--primary");
  await userEvent.click(action);
  expect(mocks.alignLyrics).toHaveBeenCalledWith(props.relPath, expect.objectContaining({
    text: "First\n\nCorrected line", edited: true, force: true, source: "lrclib", expectedRevision: "revision-1",
  }));
});

it.each(["plain", "synced"] as const)("keeps the blue add-on action and the appropriate stepper for %s lyrics", async kind => {
  mocks.doc = document({ kind, text: kind === "plain" ? "Words" : "[00:01]Words" }); mocks.engine = null;
  mount();
  const action = button(`${kind === "synced" ? "Re-sync" : "Sync"} with Flipspin Add-on`);
  expect(action).toHaveClass("lyrics-krobi-action");
  expect(action).toHaveAttribute("title", "Needs the Lyrics add-on · opens Settings → Engines");
  expect(Boolean(screen.queryByRole("button", { name: "Advance" }))).toBe(kind === "synced");
  await previewCatalog();
  expect(screen.queryByRole("button", { name: /with Flipspin/ })).toBeNull();
  expect(screen.queryByText("Add-on")).toBeNull();
});

it("deletes the current lyric and returns to the first available preview", async () => {
  const view = mount(); await screen.findByText("Album · 2:46 · 2 lines");
  await userEvent.click(button("Delete lyrics"));
  expect(mocks.deleteLyrics).toHaveBeenCalledWith(props.relPath);
  view.rerender(<LyricsModal {...props} />);
  expect(screen.getByText("Catalog words")).toBeVisible();
  expect(versionRows().some(row => row.hasAttribute("aria-current"))).toBe(false);
  expect(button("Use these lyrics")).toBeVisible();
});

it("opens the file picker from its persistent text link", async () => {
  mount();
  const input = screen.getByLabelText("Import .txt or .lrc");
  const click = vi.spyOn(input, "click");
  await userEvent.click(button("Open file…"));
  expect(click).toHaveBeenCalledTimes(1);
});

it("uses Missing for absent track metadata", () => {
  render(<LyricsModal {...props} track={null} />);
  expect(window.document.querySelector('[data-kind="noTitle"]')).toBeVisible();
  expect(window.document.querySelector('[data-kind="noArtist"]')).toBeVisible();
  expect(window.document.querySelector('[data-kind="unmeasured"]')).toBeVisible();
});

it("syncs a picked original 30 s stamp at 29.6 s to +0.4 s sooner and flushes immediately", async () => {
  mocks.doc = document({ text: "[offset:+7000]\n[00:01]First\n[00:30]Picked line", offsetMs: 7000 });
  const audio = documentAudio(); audio.currentTime = 29.6;
  mocks.player = { audioRef: { current: audio }, nowPlaying: { path: props.relPath }, isPlaying: true, setIsPlaying: vi.fn(), play: vi.fn() };
  mount(); await userEvent.click(button("Sync to a line"));
  expect(screen.getByText("SYNC TO A LINE")).toBeVisible();
  expect(screen.getByText("“Picked line”")).toBeVisible();
  expect(button("Picked line")).toHaveAttribute("aria-pressed", "true");
  await userEvent.click(button("First"));
  expect(screen.getByText("“First”")).toBeVisible();
  expect(audio.currentTime).toBe(29.6);
  await userEvent.click(button("Picked line"));
  await userEvent.click(button("Now Space"));
  expect(mocks.saveLyricsOffset).toHaveBeenCalledExactlyOnceWith(props.relPath, 400, expect.objectContaining({ revision: "revision-1" }));
  expect(screen.queryByText("SYNC TO A LINE")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Offset in seconds" })).toHaveValue("+0.4");
  expect(screen.getByText("sooner")).toBeVisible();
});

it.each(["Escape", "Cancel"])("%s leaves line-sync without saving or closing the window", async action => {
  mount(); await userEvent.click(button("Sync to a line"));
  if (action === "Escape") fireEvent.keyDown(button("Now Space"), { key: "Escape" });
  else await userEvent.click(button("Cancel"));
  expect(screen.queryByText("SYNC TO A LINE")).toBeNull();
  expect(mocks.saveLyricsOffset).not.toHaveBeenCalled();
  expect(mocks.saveLyrics).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});

it("scopes Space to the mode's surface, ignores repeats, and releases it after leaving", async () => {
  const audio = documentAudio(); audio.currentTime = 0.6;
  mocks.player = { audioRef: { current: audio }, nowPlaying: { path: props.relPath }, isPlaying: true, setIsPlaying: vi.fn(), play: vi.fn() };
  const playerSpace = vi.fn();
  window.addEventListener("keydown", playerSpace);
  try {
    const view = mount();
    fireEvent.keyDown(button("Edit text"), { key: " ", code: "Space" });
    expect(playerSpace).toHaveBeenCalledTimes(1);
    await userEvent.click(button("Sync to a line"));
    fireEvent.keyDown(button("Now Space"), { key: " ", code: "Space", repeat: true });
    expect(mocks.saveLyricsOffset).not.toHaveBeenCalled();
    fireEvent.keyDown(window.document.body, { key: " ", code: "Space" });
    expect(playerSpace).toHaveBeenCalledTimes(2);
    await userEvent.keyboard(" ");
    expect(mocks.saveLyricsOffset).toHaveBeenCalledTimes(1);
    expect(playerSpace).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(button("Edit text"), { key: " ", code: "Space" });
    expect(playerSpace).toHaveBeenCalledTimes(3);
    view.unmount();
    fireEvent.keyDown(window.document.body, { key: " ", code: "Space" });
    expect(playerSpace).toHaveBeenCalledTimes(4);
  } finally { window.removeEventListener("keydown", playerSpace); }
});

it("starts a paused song three seconds before the picked corrected time and waits for the next press", async () => {
  mocks.doc = document({ text: "[offset:+2000]\n[00:30]Picked line", offsetMs: 2000 });
  const audio = documentAudio(); audio.currentTime = 10;
  const start = vi.fn();
  mocks.player = { audioRef: { current: audio }, nowPlaying: { path: props.relPath }, isPlaying: false, setIsPlaying: start, play: vi.fn() };
  const view = mount(); await userEvent.click(button("Sync to a line"));
  await userEvent.click(button("Now Space"));
  expect(audio.currentTime).toBe(25); expect(start).toHaveBeenCalledWith(true);
  expect(mocks.saveLyricsOffset).not.toHaveBeenCalled();
  expect(screen.getByText("SYNC TO A LINE")).toBeVisible();
  mocks.player.isPlaying = true; audio.currentTime = 29.6;
  view.rerender(<LyricsModal {...props} />);
  await userEvent.click(button("Now Space"));
  expect(mocks.saveLyricsOffset.mock.calls[0][1]).toBe(400);
});

it("bakes the pending correction once, zeroes the tag, and restores all record facts", async () => {
  // Keep the pending autosave debounce from expiring between the two clicks.
  vi.useFakeTimers();
  const user = clockUser();
  const before = document({ text: "[00:30.00]Picked line", source: "genius", providerRef: "genius:1", edited: false,
    fetchedAt: 42, title: "Catalog title", artist: "Artist", lineConfidence: [0.9], lowLines: [0], result: { timingSource: "aligned:mms-fa", helperName: "Studio" } });
  mocks.doc = before;
  const confirm = vi.spyOn(window, "confirm");
  mount(); expect(screen.queryByRole("button", { name: "Write into timestamps" })).toBeNull();
  await user.click(button("Advance"));
  expect(button("Write into timestamps")).toHaveAttribute("title", "For players that ignore the offset tag");
  await user.click(button("Write into timestamps"));
  expect(confirm).not.toHaveBeenCalled();
  expect(mocks.saveLyricsOffset).not.toHaveBeenCalled();
  expect(mocks.saveLyrics).toHaveBeenCalledExactlyOnceWith(props.relPath, {
    kind: "synced", text: "[00:29.90]Picked line", source: "genius", providerRef: "genius:1", edited: false, force: false, expectedRevision: "revision-1",
    restore: { fetchedAt: 42, title: "Catalog title", artist: "Artist", lineConfidence: [0.9], lowLines: [0], result: before.result },
  });
  expect(screen.getByRole("textbox", { name: "Offset in seconds" })).toHaveValue("0.0");
  expect(screen.queryByRole("button", { name: "Write into timestamps" })).toBeNull();
});

it.each([false, true])("asks once only when timestamps would clamp and respects answer=%s", async answer => {
  mocks.doc = document({ text: "[offset:+2000]\n[00:01.00]Early line\n[00:30.00]Last line", offsetMs: 2000, edited: true });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(answer);
  mount(); await userEvent.click(button("Write into timestamps"));
  expect(confirm).toHaveBeenCalledTimes(1);
  if (answer) {
    expect(mocks.saveLyrics).toHaveBeenCalledExactlyOnceWith(props.relPath, expect.objectContaining({ text: "[00:00.00]Early line\n[00:28.00]Last line", edited: true, force: true }));
    expect(screen.queryByRole("button", { name: "Write into timestamps" })).toBeNull();
  } else {
    expect(mocks.saveLyrics).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Offset in seconds" })).toHaveValue("+2.0");
  }
});

it.each(["plain", "mismatch", "fitting"])("names the footer for %s previews and offers use-and-sync only when needed", async kind => {
  mocks.searchLyrics.mockResolvedValue({ candidates: [{ ...candidate, kind: kind === "plain" ? "plain" : "synced", text: kind === "plain" ? "Catalog words" : candidate.text,
    withinTolerance: kind !== "mismatch", durationSeconds: kind === "mismatch" ? 244 : 166, durationDeltaSeconds: kind === "mismatch" ? 78 : 0 }] });
  mount(); await previewCatalog();
  expect(button(kind === "plain" ? "Use untimed lyrics" : kind === "mismatch" ? "Use as is" : "Use these lyrics")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Sync to a line" })).toBeNull();
  if (kind === "fitting") expect(screen.queryByRole("button", { name: "Use and sync with Flipspin" })).toBeNull();
  else {
    expect(button("Use and sync with Flipspin")).toHaveAttribute("title", expect.stringContaining("Uses these lyrics, then times them to this song · "));
    let finish!: () => void;
    mocks.saveLyrics.mockImplementationOnce((_rel, payload) => new Promise(resolve => { finish = () => { mocks.doc = document({ ...payload, revision: "revision-2" }); resolve(mocks.doc); }; }));
    await userEvent.click(button("Use and sync with Flipspin"));
    expect(mocks.saveLyrics).toHaveBeenCalledTimes(1);
    expect(mocks.alignLyrics).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(mocks.alignLyrics).toHaveBeenCalledWith(props.relPath, expect.objectContaining({ text: kind === "plain" ? "Catalog words" : "Catalog words\nLast line", expectedRevision: "revision-2" }));
    expect(currentRow()).toHaveTextContent("Current");
    expect(screen.getByRole("progressbar")).toBeVisible();
  }
});

it.each(["plain", "mismatch"])("opens Settings Engines without saving a %s preview when the add-on is missing", async kind => {
  mocks.engine = null;
  mocks.searchLyrics.mockResolvedValue({ candidates: [{ ...candidate, kind: kind === "plain" ? "plain" : "synced", withinTolerance: false }] });
  const settings = vi.fn(); window.addEventListener("krobi-show-settings", settings);
  try {
    mount(); await previewCatalog(); await userEvent.click(button("Use and sync with Flipspin Add-on"));
    expect(settings.mock.calls[0][0].detail).toEqual({ section: "complementos" });
    expect(mocks.saveLyrics).not.toHaveBeenCalled(); expect(mocks.alignLyrics).not.toHaveBeenCalled();
  } finally { window.removeEventListener("krobi-show-settings", settings); }
});

it("keeps the picked line when a pending nudge finishes saving its offset tag", async () => {
  const view = mount(); await userEvent.click(button("Advance"));
  await userEvent.click(button("Sync to a line"));
  await waitFor(() => expect(mocks.saveLyricsOffset).toHaveBeenCalledTimes(1));
  view.rerender(<LyricsModal {...props} />);
  expect(screen.getByText("“Current words”")).toBeVisible();
  expect(button("Now Space")).toBeVisible();
});

it("prepares an unplayed song, clamps the lead-in to zero and cleans up on Cancel", async () => {
  const audio = documentAudio(); audio.currentTime = 15;
  mocks.player.audioRef.current = audio;
  const view = mount(); await userEvent.click(button("Sync to a line"));
  await userEvent.click(button("Now Space"));
  expect(mocks.player.play).toHaveBeenCalledWith({ path: props.relPath });
  expect(mocks.saveLyricsOffset).not.toHaveBeenCalled();
  mocks.player.nowPlaying = { path: props.relPath }; mocks.player.isPlaying = true;
  view.rerender(<LyricsModal {...props} />);
  fireEvent(audio, new Event("loadedmetadata"));
  expect(audio.currentTime).toBe(0);
  expect(button("Now Space")).toBeVisible();
  await userEvent.click(button("Cancel"));
  audio.currentTime = 10; fireEvent(audio, new Event("loadedmetadata"));
  expect(audio.currentTime).toBe(10);
});

it("serializes a bake after an in-flight nudge and uses the returned revision", async () => {
  let finish!: () => void;
  mocks.saveLyricsOffset.mockImplementationOnce((_path, offsetMs, doc) => new Promise(resolve => {
    finish = () => { mocks.doc = { ...doc, text: setLyricsOffset(doc.text, offsetMs), offsetMs, revision: "offset-revision" }; resolve(mocks.doc); };
  }));
  mount(); await userEvent.click(button("Advance"));
  await waitFor(() => expect(mocks.saveLyricsOffset).toHaveBeenCalledTimes(1));
  await userEvent.click(button("Write into timestamps"));
  expect(mocks.saveLyrics).not.toHaveBeenCalled();
  await act(async () => finish());
  expect(mocks.saveLyrics).toHaveBeenCalledExactlyOnceWith(props.relPath, expect.objectContaining({ text: "[00:00.9]Current words", expectedRevision: "offset-revision" }));
  expect(screen.getByRole("textbox", { name: "Offset in seconds" })).toHaveValue("0.0");
});

it("does not start sync if using the version fails", async () => {
  mocks.searchLyrics.mockResolvedValue({ candidates: [{ ...candidate, kind: "plain", text: "Words" }] });
  mocks.saveLyrics.mockRejectedValueOnce(new Error("save failed"));
  mount(); await previewCatalog(); await userEvent.click(button("Use and sync with Flipspin"));
  expect(mocks.alignLyrics).not.toHaveBeenCalled();
  expect(screen.getByRole("alert")).toHaveTextContent("Couldn't save lyrics");
});

it("carries use-and-sync through the existing edited-lyric confirmation", async () => {
  mocks.doc = document({ edited: true });
  mocks.searchLyrics.mockResolvedValue({ candidates: [{ ...candidate, kind: "plain", text: "Words" }] });
  mount(); await previewCatalog(); await userEvent.click(button("Use and sync with Flipspin"));
  expect(mocks.saveLyrics).not.toHaveBeenCalled(); expect(mocks.alignLyrics).not.toHaveBeenCalled();
  await userEvent.click(button("Use LRCLIB"));
  expect(mocks.saveLyrics).toHaveBeenCalledTimes(1); expect(mocks.alignLyrics).toHaveBeenCalledTimes(1);
});
