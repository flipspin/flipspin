import { installTestClock, clockUser, waitForClock as waitFor } from '../test/test-clock'
import { act, fireEvent, render as renderComponent, screen, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import i18n from "../i18n";
import type { LyricsDoc, LyricsEngine } from "./lyricsStore";
import type { SchemaMacWorker } from "../api/generated/schema";
import { summaryFixture } from "../settings/background/fixtures.testdata";
import { computeKey } from "../settings/background/data";

const mocks = vi.hoisted(() => ({
  engine: null as LyricsEngine | null, apiGet: vi.fn(),
  alignLyrics: vi.fn(), jobProgress: vi.fn(), loadLyrics: vi.fn(), refreshJobs: vi.fn(), cancelEngineRun: vi.fn(),
}));
vi.mock("../data", async original => ({
  ...await original<typeof import("../data")>(), apiGet: mocks.apiGet,
}));
vi.mock("./lyricsStore", async original => ({
  ...await original<typeof import("./lyricsStore")>(), ...mocks,
  useLyricsJobs: () => ({ engine: mocks.engine }), watchJobs: () => () => {},
}));
vi.mock("./macEngine", () => ({ refreshMac: vi.fn(), useMacEngine: () => ({ available: false, status: null, lastError: null }) }));
import LyricsSyncControl from "./LyricsSyncControl";
import { useLyricsSync } from "./useLyricsSync";
import { __resetSyncRunsForTest, startCurrentSync } from "./syncRunStore";

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


let client: QueryClient;
function render(ui: ReactElement) {
  return renderComponent(ui, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });
}

const helper: SchemaMacWorker = {
  id: "helper-1", name: "Studio", nest: false, os: "macos", accel: "mlx", memoryBytes: 16 * 2 ** 30,
  jobs: ["align"], state: "idle", keepAwake: "none", lastSeenAt: 1, version: "0.12.0", minimumVersion: "0.10.0", versionState: "update",
};
const lyric = (overrides: Partial<LyricsDoc> = {}): LyricsDoc => ({
  relPath: "Album/Song.mp3", kind: "synced", text: "[00:01]First\n[00:04]Last", source: "lrclib",
  fetchedAt: 42, edited: false, offsetMs: 0, revision: "rev-1", title: "Catalog title",
  result: { durationSeconds: 211, durationDeltaSeconds: 1 }, ...overrides,
});
function Panel({ doc, shown = 0, inline = false, sidebar = false }: { doc: LyricsDoc; shown?: number; inline?: boolean; sidebar?: boolean }) {
  const engine = useLyricsSync(doc.relPath, 210, i18n.t);
  return <LyricsSyncControl t={i18n.t} lyric={doc} engine={engine} onSync={() => void startCurrentSync(doc.relPath, doc)} open inline={inline || sidebar} sidebar={sidebar}
    shown={shown} onChange={vi.fn()} onStep={vi.fn()} onReset={vi.fn()} saveState="idle" />;
}
beforeEach(async () => {
  vi.clearAllMocks(); await i18n.changeLanguage("en");
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mocks.apiGet.mockResolvedValue(summaryFixture());
  mocks.engine = { ready: true, mode: "agent", helpers: [helper], queue: { agents: [{ version: "0.12.0" }] } } as LyricsEngine;
  mocks.alignLyrics.mockResolvedValue({ progressId: "align-1" });
  mocks.jobProgress.mockResolvedValue({ terminal: false, active: { Song: { phase: "alineando", percent: 35 } } });
  mocks.cancelEngineRun.mockResolvedValue(true); mocks.loadLyrics.mockResolvedValue(null); mocks.refreshJobs.mockResolvedValue(null);
});
afterEach(async () => { __resetSyncRunsForTest(); client.clear(); vi.restoreAllMocks(); await i18n.changeLanguage("es"); });

function runningEngine(phase = "queued") {
  return { ready: true, available: true, run: { phase, running: true, progressId: "align-1", percent: 0 }, cancel: vi.fn() } as unknown as ReturnType<typeof useLyricsSync>;
}
function runningPanel(engine: ReturnType<typeof useLyricsSync>, sidebar = true) {
  return <LyricsSyncControl t={i18n.t} lyric={lyric()} engine={engine} onSync={vi.fn()} open inline={sidebar} sidebar={sidebar}
    shown={0} onChange={vi.fn()} onStep={vi.fn()} onReset={vi.fn()} saveState="idle" />;
}
function sleepingSummary() {
  const summary = summaryFixture();
  summary.kinds[0].waitingFor = "big_chip";
  summary.computers[1].name = "big_chip";
  summary.computers[1].lastSeenAt = new Date(2026, 10, 12, 9, 7).getTime() / 1000;
  return summary;
}

it.each([true, false])("shows the sleeping helper, local last-seen time, pending steps and cancel on sidebar=%s", async sidebar => {
  await i18n.changeLanguage("es");
  mocks.apiGet.mockResolvedValue(sleepingSummary());
  const engine = runningEngine(sidebar ? "queued" : "en cola");
  render(runningPanel(engine, sidebar));
  expect(await waitFor(() => screen.getByText("Esperando a big_chip"))).toBeVisible();
  expect(screen.getByText("Dormido · empieza cuando despierte")).toHaveAttribute("title", "big_chip está dormido · visto por última vez 09:07");
  expect(screen.getByText("En cola")).toBeVisible();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(document.querySelector(".lyrics-engine-steps")).toHaveTextContent("decodificar · separar voz · alinear · guardar");
  expect(document.querySelector("[aria-current=step]")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Cancelar" }));
  expect(engine.cancel).toHaveBeenCalledOnce();
});

it.each([
  ["closed", "Closed · starts when it opens", "big_chip is closed · last seen 09:07"],
  ["offline", "Offline · starts when it's back", "big_chip is offline · last seen 09:07"],
] as const)("describes a %s helper", async (state, detail, tooltip) => {
  const summary = sleepingSummary(); summary.computers[1].state = state;
  mocks.apiGet.mockResolvedValue(summary);
  render(runningPanel(runningEngine()));
  expect(await waitFor(() => screen.getByText(detail))).toHaveAttribute("title", tooltip);
});

it("returns to normal progress when the queued job is claimed without polling compute", async () => {
  vi.useFakeTimers();
  mocks.apiGet.mockResolvedValue(sleepingSummary());
  const engine = runningEngine();
  const view = render(runningPanel(engine));
  await act(() => vi.advanceTimersByTimeAsync(10));
  expect(screen.getByText("Waiting for big_chip")).toBeVisible();
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(mocks.apiGet).toHaveBeenCalledTimes(1);
  view.rerender(runningPanel({ ...engine, run: { ...engine.run!, phase: "claimed", percent: 12 } }));
  expect(screen.getByText("Syncing · 12 %")).toBeVisible();
  expect(screen.getByRole("progressbar", { name: "Syncing" })).toHaveAttribute("value", "12");
  await act(() => i18n.changeLanguage("es"));
  view.rerender(runningPanel({ ...engine, run: { ...engine.run!, phase: "claimed", percent: 12 } }));
  expect(screen.getByRole("progressbar", { name: "Sincronizando" })).toHaveAttribute("value", "12");
  await act(() => i18n.changeLanguage("en"));
  view.rerender(runningPanel({ ...engine, run: { ...engine.run!, phase: "claimed", percent: 12 } }));
  expect(screen.getByText("Timing from audio")).toBeVisible();
  expect(screen.queryByText("Waiting for big_chip")).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(10000));
  expect(mocks.apiGet).toHaveBeenCalledTimes(1);
});

it.each([403, 500])("silently keeps the original queued display on compute error %s, even with cached data", async status => {
  client.setQueryData(computeKey, sleepingSummary());
  mocks.apiGet.mockRejectedValue(new Error(`HTTP ${status}`));
  render(runningPanel(runningEngine()));
  await waitFor(() => expect(client.getQueryState(computeKey)?.status).toBe("error"));
  expect(screen.getByText("Syncing · 0 %")).toBeVisible();
  expect(screen.getByRole("progressbar")).toBeVisible();
  expect(screen.queryByText("Waiting for big_chip")).toBeNull();
  expect(screen.queryByText(/HTTP/)).toBeNull();
});

it("translates a paused reason at render time", async () => {
  const summary = sleepingSummary(); summary.kinds[0].reason = "paused";
  mocks.apiGet.mockResolvedValue(summary);
  const view = render(runningPanel(runningEngine()));
  expect(await waitFor(() => screen.getByText("Paused"))).toBeVisible();
  expect(document.querySelector(".lyrics-pop-source")).toHaveTextContent("Queued");
  await act(() => i18n.changeLanguage("es"));
  // The parent supplies t; a render must use the current language.
  view.rerender(runningPanel(runningEngine()));
  expect(await waitFor(() => screen.getByText("En pausa"))).toBeVisible();
});

it("keeps the original queued display when compute has no reason", async () => {
  const summary = sleepingSummary(); summary.kinds[0].reason = null;
  mocks.apiGet.mockResolvedValue(summary);
  render(runningPanel(runningEngine()));
  await waitFor(() => expect(client.getQueryState(computeKey)?.status).toBe("success"));
  expect(screen.getByText("Syncing · 0 %")).toBeVisible();
  expect(screen.getByRole("progressbar")).toBeVisible();
});

it.each([null, "claimed", "aligning"])("does not fetch compute without a queued run: %s", async phase => {
  vi.useFakeTimers();
  const engine = runningEngine(phase ?? "");
  if (phase === null) engine.run = undefined;
  render(runningPanel(engine));
  await act(() => vi.advanceTimersByTimeAsync(10000));
  expect(mocks.apiGet).not.toHaveBeenCalled();
});

it("shows catalog provenance and shares the blue re-sync action with no engine row", async () => {
  render(<Panel doc={lyric()} />);
  expect(screen.getByText("Timed by LRCLIB")).toBeVisible();
  expect(screen.getByText("Catalog title · 3:31 · Δ +1 s")).toBeVisible();
  expect(screen.queryByText("Studio · MLX · ready")).toBeNull();
  const action = screen.getByRole("button", { name: "Re-sync with Flipspin" });
  expect(action).toHaveClass("lyrics-krobi-action");
  expect(action).toHaveAttribute("title", "Studio · MLX · ≈ 25 s");
  expect(action.querySelector(".lucide-audio-lines")).toBeNull();
  expect(action.querySelector(".lucide-rotate-ccw, .lucide-refresh-cw")).toBeNull();
  expect(screen.getByRole("button", { name: "Delay" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Advance" })).toBeVisible();
  await user.click(action);
  expect(mocks.alignLyrics).toHaveBeenCalledWith("Album/Song.mp3", expect.objectContaining({ text: "First\nLast" }));
});

it("shows Genius words and the blue sync action with an engine tooltip", () => {
  render(<Panel doc={lyric({ kind: "plain", text: "First\n\nLast", source: "genius" })} />);
  expect(screen.getByText("Words from Genius")).toBeVisible();
  expect(screen.getByText("2 lines · no timing")).toBeVisible();
  expect(screen.getByRole("button", { name: "Sync with Flipspin" })).toHaveAttribute("title", "Studio · MLX · ≈ 25 s");
  const action = screen.getByRole("button", { name: "Sync with Flipspin" });
  expect(action).toHaveClass("lyrics-krobi-action");
  expect(action.querySelector(".lucide-audio-lines")).toBeNull();
  expect(screen.queryByRole("button", { name: "Delay" })).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
});

it.each([["decodificando", "decode", "decode · separate · align · save"], ["separando", "separate", "decode ✓ · separate · align · save"],
  ["alineando", "align", "decode ✓ · separate ✓ · align · save"], ["guardando", "save", "decode ✓ · separate ✓ · align ✓ · save"]])(
  "shows progress and the current step for %s, then cancels", async (phase, current, steps) => {
    mocks.jobProgress.mockResolvedValue({ terminal: false, active: { Song: { phase, percent: 35 } } });
    render(<Panel doc={lyric()} />);
    await user.click(screen.getByRole("button", { name: "Re-sync with Flipspin" }));
    expect(screen.getByText("Syncing · 35 %")).toBeVisible();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "35");
    expect(screen.getByText(current)).toHaveAttribute("aria-current", "step");
    expect(window.document.querySelector(".lyrics-engine-steps")).toHaveTextContent(steps);
    expect(screen.queryByRole("button", { name: "Advance" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.cancelEngineRun).toHaveBeenCalledWith("align-1");
    expect(screen.getByRole("button", { name: "Advance" })).toBeVisible();
  },
);

it("shows no engine with a reason and opens Settings Engines", async () => {
  mocks.engine = null;
  const listener = vi.fn(); window.addEventListener("krobi-show-settings", listener);
  try {
    render(<Panel doc={lyric()} />);
    expect(screen.getByRole("button", { name: "Re-sync with Flipspin Add-on" })).toHaveAttribute("title", "Needs the Lyrics add-on · opens Settings → Engines");
    await user.click(screen.getByRole("button", { name: "Re-sync with Flipspin Add-on" }));
    expect(listener.mock.calls[0][0].detail).toEqual({ section: "complementos" });
  } finally { window.removeEventListener("krobi-show-settings", listener); }
});

it("names Flipspin timing separately from word source and counts uncertain lines", () => {
  render(<Panel doc={lyric({ text: Array.from({ length: 41 }, (_, i) => `[00:${String(i).padStart(2, "0")}]Line ${i}`).join("\n"),
    source: "genius", lowLines: [1, 3], result: { timingSource: "aligned:mms-fa", helperName: "Studio" },
  })} />);
  expect(screen.getByText("Timed by Flipspin")).toBeVisible();
  expect(screen.getByText("Studio · 2 of 41 lines unsure")).toHaveAttribute("title", "Lines the aligner was unsure of (confidence under 0.15)");
  expect(screen.queryByText(/1970/)).toBeNull();
});

it("keeps the blue retry after failure, with diagnostics only in titles and the log", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const reason = "alignment failed: diagnostic detail";
  mocks.alignLyrics.mockRejectedValueOnce(new Error(reason));
  render(<Panel doc={lyric({ edited: true })} />);
  await user.click(screen.getByRole("button", { name: "Re-sync with Flipspin" }));
  expect(screen.getByText("Couldn’t sync")).toHaveAttribute("title", reason);
  expect(screen.queryByText(reason)).toBeNull(); expect(console.error).toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Re-sync with Flipspin" })).toHaveClass("lyrics-krobi-action");
  await user.click(screen.getByRole("button", { name: "Re-sync with Flipspin" }));
  expect(mocks.alignLyrics).toHaveBeenCalledTimes(2);
});

it("uses measured helper speed when present and the same panel inline", () => {
  mocks.engine!.helpers = [{ ...helper, speed: { align: { samples: 3, medianSecondsPerMinute: 4 } } }];
  render(<Panel doc={lyric({ kind: "plain", source: "manual", text: "Own words" })} inline />);
  const panel = screen.getByRole("group", { name: "Lyrics sync" });
  expect(within(panel).getByText("Your text")).toBeVisible();
  expect(within(panel).getByRole("button", { name: "Sync with Flipspin" })).toHaveAttribute("title", "Studio · MLX · ≈ 14 s");
  expect(window.document.querySelectorAll(".lyrics-pop")).toHaveLength(1);
});

it("preserves edit status, blank lines and words while stripping only timing and metadata", async () => {
  render(<Panel doc={lyric({ edited: true, text: "[ti:Song]\n[00:01]<00:01.20>First\n\n[00:03]Last" })} />);
  expect(screen.getByText("Synced · edited ✎")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Re-sync with Flipspin" }));
  expect(mocks.alignLyrics).toHaveBeenCalledWith("Album/Song.mp3", expect.objectContaining({
    text: "First\n\nLast", edited: true, force: true, expectedRevision: "rev-1",
  }));
});

it("keeps elapsed time across phase polls and highlights a nonzero adjustment", async () => {
  vi.useFakeTimers(); render(<Panel doc={lyric()} shown={0.4} />);
  expect(screen.getByRole("textbox").closest("label")).toHaveClass("is-adjusted");
  fireEvent.click(screen.getByRole("button", { name: "Re-sync with Flipspin" }));
  await act(async () => {});
  await act(() => vi.advanceTimersByTimeAsync(2100));
  expect(screen.getByText(/Studio · MLX · .* · 2 s/)).toBeVisible();
});

it("unfolds repeated chorus stamps in playback order before re-timing", async () => {
  render(<Panel doc={lyric({ text: "[00:01][00:05]Chorus\n[00:03]Verse" })} />);
  await user.click(screen.getByRole("button", { name: "Re-sync with Flipspin" }));
  expect(mocks.alignLyrics).toHaveBeenCalledWith("Album/Song.mp3", expect.objectContaining({ text: "Chorus\nVerse\nChorus" }));
});

it("derives the catalog delta from known lengths and omits unavailable facts", () => {
  const view = render(<Panel doc={lyric({ result: { durationSeconds: 208 } })} />);
  expect(screen.getByText("Catalog title · 3:28 · Δ −2 s")).toBeVisible();
  view.rerender(<Panel doc={lyric({ title: null, result: null })} />);
  expect(window.document.querySelector(".lyrics-pop-facts")).toBeNull();
});

it("puts the helper and estimate in the sidebar action tooltip instead of an engine row", () => {
  render(<Panel doc={lyric()} sidebar />);
  expect(screen.getByRole("button", { name: "Re-sync with Flipspin" })).toHaveAttribute("title", "Studio · MLX · ≈ 25 s");
  expect(screen.queryByText("Studio · MLX · ready")).toBeNull();
  expect(screen.getByText("SYNC")).toBeVisible();
  expect(screen.getByText("Timed by LRCLIB")).toBeVisible();
  expect(window.document.querySelector(".lyrics-engine")).toBeNull();
});

it("uses fixed clicks and Shift steps of one second for clicks and field arrows", () => {
  const step = vi.fn();
  const engine = { ready: true, available: true, run: null } as ReturnType<typeof useLyricsSync>;
  render(<LyricsSyncControl t={i18n.t} lyric={lyric()} engine={engine} onSync={vi.fn()} open
    shown={0} onChange={vi.fn()} onStep={step} onReset={vi.fn()} saveState="idle" />);
  const plus = screen.getByRole("button", { name: "Advance" });
  for (let i = 0; i < 6; i++) fireEvent.click(plus);
  expect(step.mock.calls.map(call => call[0])).toEqual([0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
  fireEvent.click(plus, { shiftKey: true });
  expect(step).toHaveBeenLastCalledWith(1);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowDown", shiftKey: true });
  expect(step).toHaveBeenLastCalledWith(-1);
});

it.each([false, true])("shows signed readouts with direction words on sidebar=%s", sidebar => {
  const view = render(<Panel doc={lyric()} shown={0.3} sidebar={sidebar} />);
  expect(screen.getByRole("textbox")).toHaveValue("+0.3");
  expect(screen.getByRole("textbox").closest("label")).toHaveTextContent("s sooner");
  view.rerender(<Panel doc={lyric()} shown={-0.2} sidebar={sidebar} />);
  expect(screen.getByRole("textbox")).toHaveValue("−0.2");
  expect(screen.getByText("later")).toBeVisible();
  view.rerender(<Panel doc={lyric()} shown={0} sidebar={sidebar} />);
  expect(screen.getByRole("textbox")).toHaveValue("0.0");
  expect(screen.queryByText(/^(sooner|later)$/)).toBeNull();
});
