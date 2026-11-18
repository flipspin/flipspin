import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LyricsDoc, LyricsEngine } from "./lyricsStore";
import type { MacState } from "./macEngine";
const mocks = vi.hoisted(() => ({
  engine: null as LyricsEngine | null,
  mac: { available: false, status: null, lastError: null } as MacState,
  transcribe: vi.fn(), jobProgress: vi.fn(), loadLyrics: vi.fn(), saveLyrics: vi.fn(), installEngine: vi.fn(),
  installMacEngine: vi.fn(), startMacAgent: vi.fn(), closeLyrics: vi.fn(), openLyricsModal: vi.fn(),
}));
vi.mock("./lyricsStore", async (original) => ({
  ...await original<typeof import("./lyricsStore")>(),
  useLyricsJobs: () => ({ engine: mocks.engine }), watchJobs: () => () => {},
  transcribe: mocks.transcribe, jobProgress: mocks.jobProgress, loadLyrics: mocks.loadLyrics,
  saveLyrics: mocks.saveLyrics, refreshJobs: vi.fn(), installEngine: mocks.installEngine,
  closeLyrics: mocks.closeLyrics, openLyricsModal: mocks.openLyricsModal,
}));
vi.mock("./macEngine", () => ({
  useMacEngine: () => mocks.mac, getMacState: () => mocks.mac, refreshMac: vi.fn(),
  installMacEngine: mocks.installMacEngine, startMacAgent: mocks.startMacAgent,
}));
import LyricsTimingRow from "./LyricsTimingRow";
import { __resetSyncRunsForTest } from "./syncRunStore";
const path = "Album/Song.mp3";
const plain = { kind: "plain", text: "First line\n\nLast line", lowLines: [] } as LyricsDoc;
const synced = { kind: "synced", text: "[00:01]First line\n[00:02]Last line", lowLines: [1] } as LyricsDoc;
function draw(doc: LyricsDoc | null = plain, extra = {}) {
  return render(<LyricsTimingRow relPath={path} doc={doc} known {...extra} />);
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.engine = { mode: "local", ready: true, version: "0.5.0", supported: true } as LyricsEngine;
  mocks.mac = { available: false, status: null, lastError: null };
  mocks.transcribe.mockResolvedValue({ progressId: "run", total: 1 });
  mocks.jobProgress.mockResolvedValue({ terminal: false, active: { song: { phase: "alineando", percent: 40 } } });
  mocks.loadLyrics.mockResolvedValue(synced);
  mocks.saveLyrics.mockResolvedValue(plain);
});
afterEach(() => { __resetSyncRunsForTest(); vi.useRealTimers(); });
describe("permanent timing row", () => {
  it.each([null, { kind: "instrumental", text: "", lowLines: [] }, { kind: "plain", text: "  ", lowLines: [] }])("keeps an empty state and every acquisition action for %j", async (doc) => {
    draw(doc as LyricsDoc);
    expect(screen.getByRole("region", { name: "tiempos" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Sincronizar" })).toBeDisabled();
    expect(screen.getByText("falta la letra")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Buscar" }));
    expect(mocks.openLyricsModal).toHaveBeenCalledWith(path);
    await userEvent.click(screen.getByRole("button", { name: "Pegar o importar letra" }));
    expect(mocks.openLyricsModal).toHaveBeenLastCalledWith(path, "own");
  });
  it("sends the exact plain words, preserving stanza breaks, and keeps the real phase across reopen", async () => {
    const view = draw();
    await userEvent.click(screen.getByRole("button", { name: "Sincronizar" }));
    expect(mocks.transcribe).toHaveBeenCalledWith([{ relPath: path, text: plain.text }]);
    expect(await screen.findByText("alineando · 40%")).toBeVisible();
    view.unmount(); draw();
    expect(screen.getByText("alineando · 40%")).toBeVisible();
    expect(screen.getByRole("button", { name: "Sincronizar" })).toBeDisabled();
  });
  it.each(["aligned:mms-fa", "lrclib", "manual"])("resyncs %s words without timestamps and reviews the first flagged line", async (source) => {
    const review = vi.fn();
    draw({ ...synced, source, lowLines: [1, 0, 1, 200] }, { onReview: review });
    const button = screen.getByRole("button", { name: "Resincronizar" });
    expect(button).not.toHaveClass("waveform-btn--on");
    await userEvent.click(screen.getByRole("button", { name: "Revisar 2" }));
    expect(review).toHaveBeenCalledWith(0);
    await userEvent.click(button);
    expect(mocks.transcribe).toHaveBeenCalledWith([{ relPath: path, text: "First line\nLast line" }]);
  });
  it("offers installation with an explicit missing-engine state", async () => {
    mocks.engine = { ...mocks.engine, ready: false, hint: "not-installed" };
    draw();
    expect(screen.getByText("motor sin instalar")).toBeVisible();
    expect(screen.getByRole("button", { name: "Sincronizar" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Instalar en Motores" }));
    expect(mocks.installEngine).not.toHaveBeenCalled();
  });
  it("detects a 0.4.0 Mac via the server and provides web settings repair", async () => {
    mocks.engine = { ...mocks.engine, mode: "agent", queue: { agents: [{ version: "0.4.0" }] } } as LyricsEngine;
    const settings = vi.fn(); window.addEventListener("krobi-show-settings", settings);
    draw();
    expect(screen.getByText("motor 0.4.0, falta actualizar")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Instalar en Motores" }));
    expect(settings.mock.calls[0][0].detail).toEqual({ section: "complementos" });
    expect(mocks.closeLyrics).toHaveBeenCalledOnce();
    window.removeEventListener("krobi-show-settings", settings);
  });
  it("routes an outdated Mac to its persisted worker switch", async () => {
    mocks.engine = { ...mocks.engine, mode: "agent", queue: { agents: [{ version: "0.4.0" }] } } as LyricsEngine;
    mocks.mac = { available: true, status: { supported: true, installed: true, uv: true } } as MacState;
    const settings = vi.fn(); window.addEventListener("krobi-show-settings", settings);
    draw();
    await userEvent.click(screen.getByRole("button", { name: "Instalar en Motores" }));
    expect(settings.mock.calls[0][0].detail).toEqual({ section: "complementos" });
    expect(mocks.installMacEngine).not.toHaveBeenCalled();
    window.removeEventListener("krobi-show-settings", settings);
  });
  it("does not send text to an unknown or mixed-version pool", () => {
    mocks.engine = { ...mocks.engine, mode: "agent", queue: { agents: [{ version: "0.5.0" }, { version: "0.4.0" }] } } as LyricsEngine;
    const view = draw();
    expect(screen.getByRole("button", { name: "Sincronizar" })).toBeDisabled();
    mocks.engine.queue.agents = [];
    view.rerender(<LyricsTimingRow relPath={path} doc={plain} known />);
    expect(screen.getByText("versión del motor desconocida")).toBeVisible();
  });
  it("routes a stopped Mac to the switch without overriding its saved decision", async () => {
    mocks.engine = { ...mocks.engine, ready: false, mode: "agent" };
    mocks.mac = { available: true, status: { supported: true, installed: true, agentRunning: false } } as MacState;
    mocks.startMacAgent.mockResolvedValue(true);
    draw();
    expect(screen.getByText("equipo apagado")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Instalar en Motores" }));
    expect(mocks.startMacAgent).not.toHaveBeenCalled();
  });
  it("reserves the disconnected helper label for a known computer", () => {
    mocks.engine = { ...mocks.engine, ready: false, mode: "agent", worker: null, queue: { agents: [] } } as LyricsEngine;
    const view = draw();
    expect(screen.getByRole("status", { name: "Worker de sincronización" })).toHaveTextContent("Ningún equipo");
    mocks.engine.worker = { id: "pc-1", state: "offline" } as LyricsEngine["worker"];
    view.rerender(<LyricsTimingRow relPath={path} doc={plain} known />);
    expect(screen.getByRole("status", { name: "Worker de sincronización" })).toHaveTextContent("Equipo · Sin conexión");
  });
  it("keeps the row during loading and engine status failure", () => {
    mocks.engine = null;
    draw(null, { known: false });
    expect(screen.getByText("Cargando…")).toBeVisible();
    expect(screen.getByText("motor sin conexión")).toBeVisible();
    expect(screen.getByRole("button", { name: "Sincronizar" })).toBeDisabled();
  });
  it("reloads on success and exposes terminal failure without assuming 100% means success", async () => {
    mocks.jobProgress.mockResolvedValue({ terminal: true, succeeded: 0, completed: 1, total: 1 });
    draw();
    await userEvent.click(screen.getByRole("button", { name: "Sincronizar" }));
    expect(await screen.findByText("No se pudo sincronizar")).toBeVisible();
    expect(mocks.loadLyrics).toHaveBeenCalledWith(path, { force: true });
    mocks.jobProgress.mockResolvedValue({ terminal: true, succeeded: 1 });
    await userEvent.click(screen.getByRole("button", { name: "Sincronizar" }));
    await waitFor(() => expect(screen.queryByText("No se pudo sincronizar")).toBeNull());
  });
  it("retains the job id and retries after a transport failure", async () => {
    vi.useFakeTimers();
    mocks.jobProgress.mockRejectedValueOnce(new Error("offline"));
    draw();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sincronizar" })); });
    expect(screen.getByText("sin conexión · reintentando")).toBeVisible();
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    expect(screen.getByText("alineando · 40%")).toBeVisible();
    expect(mocks.transcribe).toHaveBeenCalledOnce();
  });
});

it("shows install failures instead of returning to the old version message", () => {
  mocks.engine = { ...mocks.engine, mode: "agent", queue: { agents: [{ version: "0.4.0" }] } } as LyricsEngine;
  mocks.mac = { available: true, status: { installed: true, installError: "Download failed" } } as MacState;
  draw();
  expect(screen.getByText("No se pudo instalar el motor")).toHaveAttribute("title", "Download failed");
  expect(screen.queryByText("motor 0.4.0, falta actualizar")).toBeNull();
});
