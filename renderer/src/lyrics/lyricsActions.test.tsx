import { installTestClock, waitForClock as waitFor } from '../test/test-clock'
import { DataProvider } from '../data';
import { type ComponentType, useRef } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { installFakeBackend, type FakeBackend } from "../data/test-support";
import SelectionBar from "../ui/components/SelectionBar";
import TrackContextMenu from "../albums/TrackContextMenu";
import { songMenuItems } from "../library/tracks/songMenuItems";
import { lyricsMenuItems, useLyricsMenu } from "./useLyricsMenu";
import { __resetLyricsStoreForTest, type LyricsEngine } from "./lyricsStore";
import { useLibraryView } from "../albums/hooks/useLibraryView";
import LibraryToolbar from "../albums/LibraryToolbar";
import { songTableRootClass } from "../library/tracks/songTableColumns";
import { lyricStateFor, refreshLyricStates } from "./lyricStates";
import SongTableHeader from "../library/tracks/SongTableHeader";
import UntypedRow from "../albums/AlbumTrackRow";
import tableCss from "../styles/retro-song-table.css?raw";

installTestClock()


beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
const AlbumTrackRow = UntypedRow as unknown as ComponentType<Record<string, unknown>>;
const songs = [{ path: "/music/Album/one.mp3", title: "One" }, { path: "/music/Album/two.mp3", title: "Two" }];
const result = { states: { "Album/one.mp3": "plain", "Album/two.mp3": "pending", "Album/three.mp3": "none", "Album/four.mp3": "instrumental" }, counts: { synced: 0, plain: 1, pending: 1, none: 1, instrumental: 1, queued: 0 } };
const engine = { mode: "agent", ready: true, worker: { name: "big_chip", state: "idle" } } as LyricsEngine;
let backend: FakeBackend | undefined;
afterEach(() => { cleanup(); backend?.restore(); backend = undefined; __resetLyricsStoreForTest(); localStorage.clear(); });
function fake(helper: LyricsEngine | null = engine) {
  const bodies: { path: string; body: unknown }[] = [];
  backend = installFakeBackend({ respond: (req) => {
    if (req.pathname === "/api/stems") return { status: 200, json: { splits: [] } };
    if (req.pathname === "/api/lyrics/states") return { status: 200, json: result };
    if (req.pathname === "/api/lyrics/jobs") return { status: 200, json: { engine: helper } };
    return { status: 200, json: { jobId: "job", progressId: "job", total: 2, started: true } };
  } });
  const fetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (input instanceof Request && input.method === "POST") bodies.push({ path: new URL(input.url).pathname, body: await input.clone().json() });
    return fetch(input, init);
  };
  return bodies;
}
function bar(clear = vi.fn(), count = 2) {
  render(<DataProvider><SelectionBar tracks={songs} count={count} onClear={clear} onPlay={vi.fn()} onPlayNext={vi.fn()} onQueue={vi.fn()} playlistItems={[]} /></DataProvider>);
}
function Context({ clear }: { clear: () => void }) {
  const lyricsSubmenu = useLyricsMenu([songs[0]], clear, vi.fn());
  const items = songMenuItems({ onPlay: vi.fn(), onPlayNext: vi.fn(), onQueue: vi.fn(), lyricsSubmenu });
  return <TrackContextMenu open x={10} y={10} items={[...items, { label: "Letra…", onClick: vi.fn() }]} />;
}

describe("lyrics on the existing selection and context menus", () => {
  it("shows the bar from two songs, with the shared lyrics menu and helper name", async () => {
    fake(); const clear = vi.fn(); bar(clear);
    fireEvent.click(screen.getByRole("button", { name: "Letras" }));
    expect(screen.getByRole("menuitem", { name: "Buscar en los catálogos" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Procesar en/ })).toBeNull();
  });
  it("hides the bar for one song (its right-click menu carries the actions)", () => { fake(); bar(vi.fn(), 1); expect(screen.queryByRole("toolbar")).toBeNull(); });
  it.each(["scan"])("posts selected songs to %s and clears after success", async (action) => {
    const bodies = fake(); const clear = vi.fn(); bar(clear);
    await waitFor(() => expect(backend?.countFor("/api/lyrics/jobs")).toBeGreaterThan(0));
    // Open after the helper snapshot has landed (the menu captures its items).
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Letras" }));
    fireEvent.click(await waitFor(() => screen.getByRole("menuitem", { name: action === "scan" ? "Buscar en los catálogos" : "Procesar en big_chip" })));
    await waitFor(() => expect(clear).toHaveBeenCalledOnce());
    expect(bodies[0]).toEqual({ path: `/api/lyrics/${action}`, body: action === "scan" ? { tracks: [{ album: "Album", file: "one.mp3" }, { album: "Album", file: "two.mp3" }] } : { tracks: [{ album: "Album", file: "one.mp3", text: null }, { album: "Album", file: "two.mp3", text: null }], isolateVocals: true } });
  });
  it("offers the same two actions for one song and retains Letra…", async () => {
    const bodies = fake(); const clear = vi.fn(); render(<Context clear={clear} />);
    expect(screen.getByRole("menuitem", { name: "Letra…" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Letras" }));
    expect(screen.queryByRole("menuitem", { name: /Procesar en/ })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Buscar en los catálogos" }));
    await waitFor(() => expect(clear).toHaveBeenCalledOnce());
    expect(bodies[0].body).toEqual({ tracks: [{ album: "Album", file: "one.mp3" }] });
  });
  it("offers only catalog search when there is no helper", async () => {
    fake(null); bar(); fireEvent.click(screen.getByRole("button", { name: "Letras" }));
    expect(screen.getByRole("menuitem", { name: "Buscar en los catálogos" })).toBeEnabled();
    expect(screen.queryByRole("menuitem", { name: /Procesar en/ })).toBeNull();
  });
  it("does not clear selection on a failed request", async () => {
    backend = installFakeBackend({ respond: (req) => req.method === "POST" ? { status: 409, json: { detail: "scan-running" } } : { status: 200, json: {} } });
    const clear = vi.fn(); const error = vi.fn();
    const items = lyricsMenuItems(songs, undefined, clear, error);
    const action = items[0]; if (action.type !== "separator" && action.type !== "input") action.onClick?.();
    await waitFor(() => expect(error).toHaveBeenCalledOnce());
    expect(clear).not.toHaveBeenCalled();
  });
});

const albums = [{ path: "/music/Album", album: "Album", artist: "Artist", tracks: [...songs, { path: "/music/Album/three.mp3", title: "Three" }, { path: "/music/Album/four.mp3", title: "Four" }] }];
function Library() {
  const view = useLibraryView(albums); const searchRef = useRef<HTMLInputElement>(null);
  return <><style>{tableCss}</style><LibraryToolbar view={view} searchRef={searchRef} scoped={false} canScope={false} onScope={vi.fn()} serverCount={4} mineCount={0} accountName="Cuenta" reloading={false} onReload={vi.fn()} />
    <div data-testid="table" className={`retro-song-table ${songTableRootClass({ hidden: [] }, view.filters.lyric !== "all")}`}>
      <SongTableHeader sortField="title" sortDir="asc" onSort={vi.fn()} />
      <ul>{view.tracks.map((track, index) => <AlbumTrackRow key={track.path} track={track} album={track.album} index={index} lyricState={lyricStateFor(track, view.lyricStates)} />)}</ul>
    </div></>;
}
describe("Library Letra facet", () => {
  it("shows three counted options after Tono, filters songs, and reveals the contextual column", async () => {
    fake(); render(<DataProvider><Library /></DataProvider>);
    await act(() => refreshLyricStates());
    const table = screen.getByTestId("table");
    const cell = table.querySelector<HTMLElement>(".song-col--lyrics")!;
    expect(getComputedStyle(cell).display).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: "Letra: Todas" }));
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Todas4", "Con letra1", "Sin letra3"]);
    fireEvent.click(screen.getByRole("option", { name: /Sin letra/ }));
    expect(table).toHaveClass("song-table--lyrics");
    expect(getComputedStyle(cell).display).not.toBe("none");
    expect(within(table).getByText("Two")).toBeInTheDocument();
    expect(within(table).queryByText("One")).toBeNull();
    expect(within(table).getByText("Three")).toBeInTheDocument();
    expect(within(table).getByText("Four")).toBeInTheDocument();
    expect(table.querySelector('[data-state="pending"]')).toHaveTextContent("Sin letra");
    fireEvent.click(screen.getByRole("button", { name: /Limpiar/ }));
    expect(getComputedStyle(cell).display).toBe("none");
  });
});
