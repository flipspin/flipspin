import { installTestClock, clockUser } from '../test/test-clock'
import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { StemEngine } from '../stems/stemEngine';

// Voice behavior and its real network boundary are covered in stems/LyricsVoiceToggle.test.tsx.
vi.mock('../stems/LyricsVoiceToggle', () => ({ default: mocks.voiceToggle }));
const mocks = vi.hoisted(() => ({
  voiceToggle: vi.fn((_props: { engine: StemEngine; onOpenAddons: () => void }) => null),
  audio: { current: null as HTMLAudioElement | null },
  nowPlaying: null as Record<string, unknown> | null,
  progress: 0,
  playing: true,
  vizOpen: false,
  duration: 0,
  overlayRelPath: "Album/Song.mp3" as string | null,
  doc: null as Record<string, unknown> | null,
  known: true,
  openLyrics: vi.fn(),
  closeLyrics: vi.fn(),
  saveLyricsOffset: vi.fn(),
  setProgress: vi.fn(),
  transcribe: vi.fn(),
  alignLyrics: vi.fn(),
  cancelEngineRun: vi.fn(),
  jobProgress: vi.fn(),
  loadLyrics: vi.fn(),
  refreshJobs: vi.fn(),
  jobs: { engine: { ready: true } } as Record<string, unknown> | null,
}));


vi.mock("../settings/background/data", async original => ({
  ...await original<typeof import("../settings/background/data")>(), useCompute: () => ({ data: undefined, isError: false }),
}));
vi.mock("@state/AudioPlayerContext", () => ({
  useAudioPlayer: () => ({
    audioRef: mocks.audio,
    nowPlaying: mocks.nowPlaying,
    selectedTrack: mocks.nowPlaying,
    isPlaying: mocks.playing,
    setIsPlaying: vi.fn(),
    shuffleEnabled: false,
    toggleShuffle: vi.fn(),
    goNext: vi.fn(),
    goPrevious: vi.fn(),
    queue: [],
  }),
  useAudioDuration: () => mocks.duration,
  useAudioProgress: () => ({ progress: mocks.progress, duration: mocks.duration, setProgress: mocks.setProgress }),
}));
vi.mock("./lyricsStore", () => ({
  initializeLocalLyrics: vi.fn(),
  useLocalLyricsStatus: () => null,
  useLocalLyricsEnabled: () => false,
  closeLyrics: mocks.closeLyrics,
  lyricsKeyOf: (track: { path?: string } | null) => track?.path ?? null,
  openLyrics: mocks.openLyrics,
  saveLyricsOffset: mocks.saveLyricsOffset,
  transcribe: mocks.transcribe,
  alignLyrics: mocks.alignLyrics,
  cancelEngineRun: mocks.cancelEngineRun,
  jobProgress: mocks.jobProgress,
  loadLyrics: mocks.loadLyrics,
  refreshJobs: mocks.refreshJobs,
  useLyricsJobs: () => mocks.jobs,
  watchJobs: () => () => {},
  useLyricsReviewLine: () => null,
  useLyricsFor: () => ({ doc: mocks.doc, known: mocks.known }),
  useLyricsOverlayRelPath: () => mocks.overlayRelPath,
}));
vi.mock("./artworkPalette", () => ({ useArtworkPalette: () => ({ accent: "#fff", base: "#000" }) }));
vi.mock("../viz/vizStore", () => ({ useVizOpen: () => mocks.vizOpen }));
vi.mock("../ui/components/CoverTile", () => ({ default: () => <span data-testid="cover" /> }));
vi.mock("../viz/RealTimeWaveform", () => ({ default: () => <span data-testid="waveform" /> }));
vi.mock("@lib/api", () => ({ buildCoverImageUrl: () => null, parseTrackPath: () => ({ albumName: "Album" }) }));

import LyricsOverlay from "./LyricsOverlay";
import { __resetSyncRunsForTest } from "./syncRunStore";
import { __resetOffsetsForTest } from "./useLyricOffset";
import { setLyricsOffset } from "./lrc";

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })

afterEach(() => { __resetSyncRunsForTest(); __resetOffsetsForTest(); });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.audio.current = document.createElement("audio");
  Object.defineProperty(mocks.audio.current, "duration", { configurable: true, value: 120 });
  mocks.nowPlaying = { path: "Album/Song.mp3", title: "Song", artist: "Artist", album: "Album" };
  mocks.progress = 15;
  mocks.audio.current.currentTime = 15;
  mocks.playing = true;
  mocks.vizOpen = false;
  mocks.duration = 120;
  mocks.overlayRelPath = "Album/Song.mp3";
  mocks.known = true;
  mocks.doc = {
    kind: "synced",
    text: "[00:05.00]First line\n[00:10.00]Current line\n[00:20.00]Next line",
    source: "lrclib",
    providerRef: "42",
    edited: false,
  };
  mocks.jobs = { engine: { ready: true, mode: "local", version: "0.5.0" } };
  mocks.saveLyricsOffset.mockImplementation(async (_path, offsetMs, doc) => {
    mocks.doc = { ...doc, text: setLyricsOffset(doc.text, offsetMs), offsetMs, revision: `r${offsetMs}` };
    return mocks.doc;
  });
  mocks.alignLyrics.mockResolvedValue({ progressId: "align-1", total: 1 });
  mocks.cancelEngineRun.mockResolvedValue(true);
  mocks.transcribe.mockResolvedValue({ progressId: "p1", total: 1 });
  mocks.jobProgress.mockResolvedValue({ terminal: false, active: { Song: { phase: "alineando", percent: null } } });
  mocks.loadLyrics.mockResolvedValue(null);
  mocks.refreshJobs.mockResolvedValue(null);
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

describe("LyricsOverlay", () => {
  it('supplies the Stems snapshot and opens Add-ons through the injected callback', () => {
    render(<LyricsOverlay />);
    const props = mocks.voiceToggle.mock.calls.at(-1)![0];
    expect(props.engine).toEqual({ available: true, machine: 'Nido', backend: undefined, estimate: null });
    const event = vi.fn();
    window.addEventListener('krobi-show-settings', event);
    try {
      props.onOpenAddons();
      expect(event.mock.calls[0][0].detail).toEqual({ section: 'complementos' });
    } finally { window.removeEventListener('krobi-show-settings', event); }
  });

  it("renders synced lyrics, marks the current line, and seeks when a timestamped line is clicked", async () => {
    const user = clockUser();
    render(<LyricsOverlay />);

    expect(screen.getByText("Current line").closest("li")).toHaveClass("cur");
    await user.click(screen.getByText("Next line"));
    expect(mocks.audio.current?.currentTime).toBe(20);
  });

  it("shows the empty action and forwards it to the add/change-lyrics workflow", async () => {
    const user = clockUser();
    const onOpenModal = vi.fn();
    mocks.doc = null;
    render(<LyricsOverlay onOpenModal={onOpenModal} />);

    await user.click(screen.getByRole("button", { name: "Buscar letra" }));
    expect(onOpenModal).toHaveBeenCalledWith("Album/Song.mp3");
  });

  it("follows a newly playing queue item while the overlay stays open", () => {
    const { rerender } = render(<LyricsOverlay />);
    mocks.nowPlaying = { path: "Other/Next.mp3", title: "Next" };
    rerender(<LyricsOverlay />);
    expect(mocks.openLyrics).toHaveBeenCalledWith("Other/Next.mp3");
  });

  it("exposes a bounded seek slider", () => {
    render(<LyricsOverlay />);
    const position = screen.getByRole("slider", { name: "Posición" });
    Object.defineProperty(position, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ left: 10, width: 100 }),
    });
    fireEvent.pointerDown(position, { clientX: 200, pointerId: 1 });
    expect(mocks.audio.current?.currentTime).toBe(120);
    expect(mocks.setProgress).toHaveBeenCalledWith(120);
  });

  it("opens sync controls for plain lyrics and still offers the lyrics window", async () => {
    mocks.doc = { kind: "plain", text: "First line\nNext line", source: "genius", edited: false };
    const open = vi.fn();
    render(<LyricsOverlay onOpenModal={open} />);
    expect(screen.getByRole("button", { name: "Sincronizar" })).toBeVisible();
    expect(screen.queryByLabelText("Worker de sincronización")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Cambiar letra" }));
    expect(open).toHaveBeenCalledWith("Album/Song.mp3");
  });

  it("marks uncertain lines without showing resync controls", () => {
    mocks.doc = { ...mocks.doc, source: "aligned:mms-fa", lowLines: [2] };
    render(<LyricsOverlay />);

    expect(screen.getByText("Next line").closest("li")).toHaveClass("dudosa");
    expect(screen.getByText("First line").closest("li")).not.toHaveClass("dudosa");
    expect(screen.queryByRole("button", { name: "Resincronizar" })).toBeNull();
  });
});


describe("timing performance and saves", () => {

  const nudge = () => fireEvent.click(screen.getByRole("button", { name: "Retrasar" }));
  const open = () => fireEvent.click(screen.getByTitle("Ajustar el desfase de la letra"));
  it("retains row nodes and focus when the offset changes", () => {
    render(<LyricsOverlay />); open();
    const row = screen.getByText("Current line").closest("li")!;
    row.focus(); nudge();
    expect(screen.getByText("Current line").closest("li")).toBe(row);
    expect(document.activeElement).toBe(row);
  });
  it("does not rerender row text for a clock tick within the current line", () => {
    let tick: FrameRequestCallback = () => {};
    vi.stubGlobal("requestAnimationFrame", vi.fn((cb) => { tick = cb; return 1; }));
    render(<LyricsOverlay />);
    const pad = vi.spyOn(String.prototype, "padStart");
    mocks.audio.current!.currentTime = 15.2;
    act(() => tick(16));
    // Header stamps (4), transport times (2). No 6 additional calls for lyric rows.
    expect(pad.mock.calls.length).toBeLessThan(12);
    pad.mockRestore();
  });
  it.each(["paused", "covered"])("stops frame polling when %s, but follows seeks", (mode) => {
    mocks.playing = mode !== "paused"; mocks.vizOpen = mode === "covered";
    render(<LyricsOverlay />);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    mocks.audio.current!.currentTime = 22;
    fireEvent(mocks.audio.current!, new Event("seeked"));
    expect(screen.getByText("Next line").closest("li")).toHaveClass("cur");
  });
  it("serializes slow saves and sends only the remaining offset afterward", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    mocks.saveLyricsOffset.mockImplementationOnce((_path, offsetMs, doc) => new Promise((resolve) => {
      finish = () => { mocks.doc = { ...doc, text: setLyricsOffset(doc.text, offsetMs), offsetMs, revision: "r2" }; resolve(mocks.doc); };
    }));
    render(<LyricsOverlay />); open(); nudge();
    await act(() => vi.advanceTimersByTimeAsync(301));
    nudge(); nudge();
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(mocks.saveLyricsOffset).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    await act(() => vi.advanceTimersByTimeAsync(301));
    expect(mocks.saveLyricsOffset).toHaveBeenCalledTimes(2);
    expect(mocks.saveLyricsOffset.mock.calls[1][1]).toBe(-300);
  });
  it("ignores completion state from a previous track", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    mocks.saveLyricsOffset.mockImplementationOnce((_path, offsetMs, doc) => new Promise((resolve) => { finish = () => resolve({ ...doc, text: setLyricsOffset(doc.text, offsetMs), offsetMs }); }));
    const { rerender } = render(<LyricsOverlay />); open(); nudge();
    await act(() => vi.advanceTimersByTimeAsync(301));
    mocks.overlayRelPath = "Other/Next.mp3";
    rerender(<LyricsOverlay />);
    await act(async () => finish());
    expect(screen.getByTitle("Ajustar el desfase de la letra")).toHaveTextContent("Sincronizar");
  });
  it("uses LRC's sign: Retrasar is − and stamps later, Adelantar is + and stamps sooner", async () => {
    vi.useFakeTimers();
    render(<LyricsOverlay />); open();
    nudge();
    expect(screen.getByTitle("Ajustar el desfase de la letra")).toHaveTextContent("−0.1 s");
    await act(() => vi.advanceTimersByTimeAsync(301));
    expect(mocks.saveLyricsOffset.mock.calls[0][1]).toBe(-100);
    fireEvent.click(screen.getByRole("button", { name: "Adelantar" }));
    fireEvent.click(screen.getByRole("button", { name: "Adelantar" }));
    expect(screen.getByTitle("Ajustar el desfase de la letra")).toHaveTextContent("+0.1 s");
  });
  it("repeats a held step at 0.1 s, then 0.5 s after one second held", () => {
    vi.useFakeTimers();
    render(<LyricsOverlay />); open();
    const plus = screen.getByRole("button", { name: "Adelantar" });
    fireEvent.pointerDown(plus, { button: 0, pointerId: 1 });
    act(() => { vi.advanceTimersByTime(960); });
    expect(screen.getByTitle("Ajustar el desfase de la letra")).toHaveTextContent("+0.9 s");
    act(() => { vi.advanceTimersByTime(80); });
    fireEvent.pointerUp(plus, { pointerId: 1 });
    expect(screen.getByTitle("Ajustar el desfase de la letra")).toHaveTextContent("+1.4 s");
  });
  it("keeps six quick clicks at 0.6 s and reverses by one fixed step", () => {
    vi.useFakeTimers();
    render(<LyricsOverlay />); open();
    for (let i = 0; i < 6; i++) fireEvent.click(screen.getByRole("button", { name: "Adelantar" }));
    expect(screen.getByTitle("Ajustar el desfase de la letra")).toHaveTextContent("+0.6 s");
    nudge();
    expect(screen.getByTitle("Ajustar el desfase de la letra")).toHaveTextContent("+0.5 s");
  });
  it("resets this session's adjustment and is disabled at zero", async () => {
    vi.useFakeTimers();
    render(<LyricsOverlay />); open();
    const reset = screen.getByRole("button", { name: "Restablecer la sincronía" });
    expect(reset).toBeDisabled();
    nudge(); nudge();
    await act(() => vi.advanceTimersByTimeAsync(301));
    expect(mocks.doc!.text).toContain("[offset:-200]");
    expect(mocks.doc!.text).toContain("[00:05.00]First line");
    fireEvent.click(reset);
    expect(reset).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(301));
    expect(mocks.doc!.text).toContain("[00:05.00]First line");
  });
});

describe("following the current line", () => {
  it("stops following on a manual scroll and offers the way back", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    render(<LyricsOverlay />);
    const main = screen.getByText("Current line").closest("main")!;
    expect(screen.queryByRole("button", { name: "Volver a la línea actual" })).toBeNull();
    fireEvent.wheel(main);
    scroll.mockClear();
    mocks.audio.current!.currentTime = 22;
    fireEvent(mocks.audio.current!, new Event("seeked"));
    expect(scroll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Volver a la línea actual" }));
    expect(scroll).toHaveBeenCalled();
    expect(scroll.mock.contexts.at(-1)).toBe(screen.getByText("Next line").closest("li"));
    expect(screen.queryByRole("button", { name: "Volver a la línea actual" })).toBeNull();
  });
  it("resumes following when a line is clicked to seek", async () => {
    Element.prototype.scrollIntoView = vi.fn();
    render(<LyricsOverlay />);
    fireEvent.touchMove(screen.getByText("Current line").closest("main")!);
    expect(screen.getByRole("button", { name: "Volver a la línea actual" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("First line"));
    expect(screen.queryByRole("button", { name: "Volver a la línea actual" })).toBeNull();
  });
});

it("re-times the current words from the overlay panel", async () => {
  render(<LyricsOverlay />);
  await user.click(screen.getByTitle("Ajustar el desfase de la letra"));
  const action = screen.getByRole("button", { name: "Volver a sincronizar con Flipspin" });
  expect(action).toHaveClass("lyrics-krobi-action");
  expect(action.querySelector(".lucide-rotate-ccw, .lucide-refresh-cw")).toBeNull();
  await user.click(action);
  expect(mocks.alignLyrics).toHaveBeenCalledWith("Album/Song.mp3", expect.objectContaining({
    kind: "plain", text: "First line\nCurrent line\nNext line", source: "lrclib",
  }));
  expect(screen.getByRole("progressbar")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retrasar" })).toBeNull();
});

it("picks big lyric lines instead of seeking, keeps the glass panel open and saves Now", async () => {
  mocks.doc = { ...mocks.doc, text: "[00:01]First line\n[00:30]Picked line" };
  mocks.audio.current!.currentTime = 29.6;
  render(<LyricsOverlay />);
  await user.click(screen.getByTitle("Ajustar el desfase de la letra"));
  await user.click(screen.getByRole("button", { name: "Sincronizar con una línea" }));
  expect(screen.getByRole("button", { name: /First line/ })).toHaveAttribute("aria-pressed", "true");
  await user.click(screen.getByText("Picked line"));
  expect(mocks.audio.current!.currentTime).toBe(29.6);
  expect(screen.getByText("Picked line").closest("li")).toHaveClass("is-picked");
  expect(screen.getByText("“Picked line”")).toBeVisible();
  await user.keyboard(" ");
  expect(mocks.saveLyricsOffset).toHaveBeenCalledExactlyOnceWith("Album/Song.mp3", 400, expect.anything());
  expect(screen.queryByText("SINCRONIZAR CON UNA LÍNEA")).toBeNull();
  expect(screen.getByText("antes")).toBeVisible();
});

it("Escape cancels line-sync before closing the glass panel or the overlay", async () => {
  render(<LyricsOverlay />);
  await user.click(screen.getByTitle("Ajustar el desfase de la letra"));
  await user.click(screen.getByRole("button", { name: "Sincronizar con una línea" }));
  await user.keyboard("{Escape}");
  expect(screen.getByRole("button", { name: "Sincronizar con una línea" })).toBeVisible();
  expect(mocks.saveLyricsOffset).not.toHaveBeenCalled(); expect(mocks.closeLyrics).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("button", { name: "Sincronizar con una línea" })).toBeNull();
  expect(mocks.closeLyrics).not.toHaveBeenCalled();
});

it("follows and reviews with auto scrolling under reduced motion", () => {
  const scroll = vi.fn(); Element.prototype.scrollIntoView = scroll;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  const view = render(<LyricsOverlay />);
  scroll.mockClear();
  mocks.audio.current!.currentTime = 22;
  fireEvent(mocks.audio.current!, new Event("seeked"));
  expect(scroll).toHaveBeenLastCalledWith({ block: "center", behavior: "auto" });
  view.unmount(); vi.unstubAllGlobals();
});

it('forwards the song info opener through the lyrics sheet to its analysis chips', async () => {
  const onOpenInfo = vi.fn()
  mocks.nowPlaying = { ...mocks.nowPlaying, key: '3A', keySource: 'computed', keyEstimated: true }
  render(<LyricsOverlay onOpenInfo={onOpenInfo} />)
  const button = screen.getByRole('button', { name: /Abrir información de la canción/ })
  await user.click(button)
  button.focus()
  await user.keyboard('{Enter}')
  await user.keyboard(' ')
  expect(onOpenInfo).toHaveBeenCalledTimes(3)
  expect(onOpenInfo).toHaveBeenLastCalledWith(mocks.nowPlaying)
})
