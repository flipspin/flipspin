import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as nativeBridge from "../../bridge";
import { afterEach, expect, it, vi } from "vitest";
import { StatusProvider } from "@state/StatusContext";
vi.mock("../../viz/IsingScreen", () => ({ default: () => <div>Ising</div> }));
vi.mock("./WindowControls", () => ({ default: () => null, hasCustomWindowControls: () => false }));
vi.mock("../../plugins", () => ({ pluginPages: [] }));
const player = vi.hoisted(() => ({ play: vi.fn(), setIsPlaying: vi.fn(), source: null as null | { kind: string; name: string }, isPlaying: false }));
vi.mock("@state/AudioPlayerContext", () => ({ useAudioPlayer: () => player }));
const fetchPlaylistQueue = vi.hoisted(() => vi.fn());
vi.mock("../../playlists/playlistQueue", () => ({ fetchPlaylistQueue }));
const summaries = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("@lib/playlistSummaries", () => ({ fetchPlaylistSummaries: async () => summaries.items }));
const connection = vi.hoisted(() => ({ state: "connecting" }));
vi.mock("../../connection/connection", () => ({ useConnection: () => connection }));
import Sidebar from "./sidebar";
import { installFakeSettings, serverStatus, type FakeSettings } from "../../settings/test-support";
let fake: FakeSettings;
afterEach(() => { fake?.restore(); vi.restoreAllMocks(); });
it("keeps navigation and lists without the former Lyrics panel", () => {
  fake = installFakeSettings({ status: serverStatus({ starting: true, reachable: false }) });
  const { container } = render(<StatusProvider><Sidebar activePage="library" setActivePage={vi.fn()} selectedPlaylistName={null} setSelectedPlaylistName={vi.fn()} /></StatusProvider>);
  expect(screen.getByRole("button", { name: "Biblioteca" })).toBeInTheDocument();
  expect(screen.queryByText("Letras")).toBeNull();
  expect(container.querySelector(".lyrics-panel")).toBeNull();
});

it("folds to a strip with the button beside Flipspin, opens again from the tab or ⌘\\, and remembers it", async () => {
  fake = installFakeSettings({ status: serverStatus({ starting: true, reachable: false }) });
  // The HTTP fixture installs a bridge; this case exercises browser development.
  vi.spyOn(nativeBridge, "hasBridge").mockReturnValue(false);
  const { container, unmount } = render(<StatusProvider><Sidebar activePage="home" setActivePage={vi.fn()} selectedPlaylistName={null} setSelectedPlaylistName={vi.fn()} /></StatusProvider>);
  const shell = () => container.querySelector(".sidebar-shell");
  screen.getByRole("button", { name: "Ocultar la barra lateral" }).click();
  expect(await screen.findByRole("button", { name: "Mostrar la barra lateral" })).toBeInTheDocument();
  expect(shell()).toHaveAttribute("data-folded");
  expect(localStorage.getItem("krobi.sidebarFolded")).toBe("1");
  screen.getByRole("button", { name: "Mostrar la barra lateral" }).click();
  await vi.waitFor(() => expect(shell()).not.toHaveAttribute("data-folded"));
  // The Home rail owns Option-Command-backslash; the sidebar must stay put.
  fireEvent.keyDown(window, { key: "\\", code: "Backslash", metaKey: true, altKey: true });
  expect(shell()).not.toHaveAttribute("data-folded");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "\\", metaKey: true }));
  await vi.waitFor(() => expect(shell()).toHaveAttribute("data-folded"));
  unmount();
  localStorage.removeItem("krobi.sidebarFolded");
});

it("a native view command toggles the sidebar once, ignores the side column, and owns the accelerator", () => {
  fake = installFakeSettings({ status: serverStatus({ starting: true, reachable: false }) });
  localStorage.removeItem("krobi.sidebarFolded");
  const on = vi.spyOn(nativeBridge.bridge(), "on");
  const { container, unmount } = render(<StatusProvider><Sidebar activePage="library" setActivePage={vi.fn()} /></StatusProvider>);
  const shell = container.querySelector(".sidebar-shell");
  const subscriptions = on.mock.calls.filter(([channel]) => channel === "view:command");
  expect(subscriptions).toHaveLength(1);
  const command = subscriptions[0][1];
  act(() => command("toggle-side-column"));
  fireEvent.keyDown(window, { key: "\\", code: "Backslash", metaKey: true });
  expect(shell).not.toHaveAttribute("data-folded");
  act(() => command("toggle-sidebar"));
  expect(shell).toHaveAttribute("data-folded");
  expect(localStorage.getItem("krobi.sidebarFolded")).toBe("1");
  act(() => command("toggle-sidebar"));
  expect(shell).not.toHaveAttribute("data-folded");
  expect(screen.getByRole("button", { name: "Ocultar la barra lateral" })).toHaveAttribute("title", expect.stringContaining("⌘\\"));
  unmount();
  localStorage.removeItem("krobi.sidebarFolded");
});

it("plays a playlist from its cover, and pauses it from there while it plays", async () => {
  fake = installFakeSettings({ status: serverStatus({ starting: true, reachable: false }) });
  connection.state = "connected";
  summaries.items = [{ name: "Viaje", trackCount: 2 }, { name: "Vacía", trackCount: 0 }];
  const tracks = [{ path: "/m/A/1.mp3" }, { path: "/m/A/2.mp3" }];
  fetchPlaylistQueue.mockResolvedValue(tracks);
  const { unmount } = render(<StatusProvider><Sidebar activePage="home" setActivePage={vi.fn()} selectedPlaylistName={null} setSelectedPlaylistName={vi.fn()} /></StatusProvider>);
  (await screen.findByRole("button", { name: "Reproducir Viaje" })).click();
  expect(screen.queryByRole("button", { name: "Reproducir Vacía" })).toBeNull();
  await vi.waitFor(() => expect(player.play).toHaveBeenCalledWith(tracks[0], expect.objectContaining({ replaceQueue: true, upcomingTracks: [tracks[1]], source: { kind: "playlist", name: "Viaje" } })));
  unmount();
  player.source = { kind: "playlist", name: "Viaje" }; player.isPlaying = true;
  render(<StatusProvider><Sidebar activePage="home" setActivePage={vi.fn()} selectedPlaylistName={null} setSelectedPlaylistName={vi.fn()} /></StatusProvider>);
  (await screen.findByRole("button", { name: "Pausar" })).click();
  expect(player.setIsPlaying).toHaveBeenCalledWith(false);
  connection.state = "connecting"; summaries.items = []; player.source = null; player.isPlaying = false;
});


it("notifies other playlist consumers after creating a playlist", async () => {
  fake = installFakeSettings({ status: serverStatus({ starting: true, reachable: false }) });
  const notify = vi.fn();
  window.addEventListener("playlists-changed", notify);
  const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  try {
    render(<StatusProvider><Sidebar activePage="home" setActivePage={vi.fn()} /></StatusProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Nueva playlist" }));
    fireEvent.change(screen.getByPlaceholderText("Nombre de la playlist"), { target: { value: "Fresh list" } });
    fireEvent.click(screen.getByRole("button", { name: "Crear" }));
    await waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledWith(expect.stringContaining("/api/playlists"), expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "Fresh list", description: "" }) }));
  } finally { window.removeEventListener("playlists-changed", notify); request.mockRestore(); }
});
