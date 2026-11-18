import { waitForClock } from '../test/test-clock';
import { setLibraryPresence } from '../library/trackPresence';
import { setLibraryRoot } from '../library/libraryKeys';
import { setPlaylistViewMode } from './playlistViewMode';
import i18n from '../i18n';
import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

HTMLElement.prototype.scrollIntoView ??= () => {};

vi.mock("../data/hooks/use-library-missing", () => ({ useLibraryMissing: () => new Set<string>() }));
import PlaylistSongTable from "./PlaylistSongTable";
import { _resetForTest, setColumnVisible, setCoversVisible } from "../library/tracks/songTableColumns";
import css from "../styles/retro-song-table.css?raw";
const lyricStates = vi.hoisted(() => ({ states: {} as Record<string, "plain" | "synced"> }));
vi.mock("../lyrics/lyricStates", async importOriginal => ({
  ...await importOriginal<typeof import("../lyrics/lyricStates")>(),
  useLyricStates: () => lyricStates,
}));

vi.mock("../browse/navigationStore", () => ({ openLibraryAlbum: vi.fn(), openLibraryArtist: vi.fn() }));

const tracks = [
  { path: "/m/Discovery/01.mp3", title: "One More Time", artist: "Daft Punk", album: "Discovery", duration: 320 },
  { path: "/m/Homework/02.mp3", title: "Da Funk", album: { album: "Homework", artist: "Daft Punk" } },
];

const props = () => ({
  tracks,
  isEmpty: false,
  headColor: "#ff0",
  headInk: "#111",
  sortField: null,
  sortDir: "asc",
  onSort: vi.fn(),
  searchQuery: "",
  activePath: "/m/Homework/02.mp3",
  isSelected: () => false,
  onSelect: vi.fn(),
  onPlay: vi.fn(),
  onOpenAnalysis: vi.fn(),
  onContextMenu: vi.fn(),
});

describe("PlaylistSongTable", () => {
  afterEach(() => { act(() => _resetForTest()); lyricStates.states = {}; vi.useRealTimers(); vi.restoreAllMocks(); });

  it("auto-hides empty columns with their header and row cells intact, then restores them as the list changes", () => {
    const p = props();
    const { container, rerender } = render(<PlaylistSongTable {...p} />);
    const root = container.querySelector(".retro-song-table")!;
    for (const column of ["genre", "key", "bpm", "date", "analysis", "lyrics"]) {
      expect(root).toHaveClass(`song-table--hide-${column}`);
      expect(container.querySelectorAll(`.song-col--${column}`)).toHaveLength(3);
      expect(css).toContain(`.song-table--hide-${column} .song-col--${column}`);
      expect(css).toContain(`.song-table--hide-${column} .song-grid { --sc-${column}: 0px; }`);
    }
    fireEvent.click(screen.getByRole("button", { name: "Elegir columnas" }));
    expect(screen.getByRole("checkbox", { name: /Género/ })).toBeDisabled();
    const filled = [...tracks, { path: "/m/album/last.mp3", title: "Last", genre: "Rock", key: "3A", bpm: 120, metadata: { dateAdded: 123 } }];
    lyricStates.states = { "album/last.mp3": "plain" };
    rerender(<PlaylistSongTable {...p} tracks={filled} />);
    for (const column of ["genre", "key", "bpm", "date", "analysis", "lyrics"]) expect(root).not.toHaveClass(`song-table--hide-${column}`);
    expect(root).not.toHaveClass("song-table--lyrics"); // playlists have no lyric filter: Lyrics stays closed
    expect(container.querySelector('.song-col--lyrics[data-state="plain"]')).toHaveTextContent("Texto");
    expect(screen.getByRole("checkbox", { name: /Género/ })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /Género/ })).toBeChecked();
    expect(container.querySelectorAll(".song-col--genre")).toHaveLength(4);
    rerender(<PlaylistSongTable {...p} />);
    expect(root).toHaveClass("song-table--hide-genre");
  // Three full table renders also exercise the real column picker and every cell.
  }, 20000);

  it("uses one versioned URL per album directory and keeps header and row cells when covers toggle", () => {
    const albums = [
      { album: "Display name", mediaKey: "Discovery", coverVersion: "rev-one" },
      { album: "Same artist, other record", mediaKey: "Homework", coverVersion: "rev-two" },
    ];
    const { container } = render(<PlaylistSongTable {...props()} albums={albums} tracks={[tracks[0], { ...tracks[0], path: "/m/Discovery/another.mp3" }, tracks[1]]} />);
    const root = container.querySelector(".retro-song-table")!;
    expect(root).toHaveClass("song-table--covers");
    const images = [...container.querySelectorAll(".song-col--cover img")];
    expect(images[0]).toHaveAttribute("src", expect.stringContaining("/Discovery/cover.jpg?size=96&v=rev-one"));
    expect(images[1].getAttribute("src")).toBe(images[0].getAttribute("src"));
    expect(images[2]).toHaveAttribute("src", expect.stringContaining("/Homework/cover.jpg?size=96&v=rev-two"));
    expect(container.querySelectorAll(".song-col--artist")).toHaveLength(4);
    expect(container.querySelectorAll(".song-col--cover")).toHaveLength(4);
    act(() => setCoversVisible("playlist", false));
    expect(root).not.toHaveClass("song-table--covers");
    expect(container.querySelectorAll(".song-col--artist")).toHaveLength(4);
    expect(container.querySelectorAll(".song-col--cover")).toHaveLength(4);
    expect(container.querySelector(".song-col--cover img")).toBeNull();
    expect(css).toContain(".song-table--covers .song-col--artist { display: none !important; }");
    expect(css).toContain(".song-table--covers .song-grid { --sc-cover: calc(40px + 0.75rem); --sc-artist: 0px; }");
    expect(css).toContain(".song-grid > .song-col--cover { grid-column: cover; }");
  });

  it("measures the first row's 56px height and remeasures when Portadas changes", async () => {
    vi.useFakeTimers();
    // Keep the virtual window open: jsdom otherwise reports a 0px viewport.
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(800);
    const height = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("retro-song-table__row") ? this.closest(".song-table--covers") ? 56 : 44 : 0;
    });
    const many = Array.from({ length: 300 }, (_, i) => ({ ...tracks[0], path: `/m/Discovery/${i}.mp3` }));
    const { container } = render(<PlaylistSongTable {...props()} tracks={many} />);
    const spacer = container.querySelector<HTMLElement>(".playlist-song-rows > div")!;
    expect(height).toHaveBeenCalled();
    await waitForClock(() => expect(spacer.style.height).toBe(`${300 * 56}px`));
    act(() => setCoversVisible("playlist", false));
    await waitForClock(() => expect(spacer.style.height).toBe(`${300 * 44}px`));
    act(() => setCoversVisible("playlist", true));
    await waitForClock(() => expect(spacer.style.height).toBe(`${300 * 56}px`));
    expect(css).toContain(".song-table--covers .retro-song-table__row { height: 56px; min-height: 56px; max-height: 56px; box-sizing: border-box; }");
  // Renders and remeasures a 300-song virtual table through both cover toggles.
  }, 20000);

  it("uses the listing's media key for nested albums even before the library root is known", () => {
    const track = { path: "/library/Artist/Record/song.mp3", title: "Song", album: "A different display name" };
    const albums = [{ album: "A different display name", mediaKey: "Artist∕Record", coverVersion: "nested-revision", tracks: [track] }];
    const { container } = render(<PlaylistSongTable {...props()} tracks={[track]} albums={albums} />);
    expect(container.querySelector("img")).toHaveAttribute("src", expect.stringContaining("/Artist%E2%88%95Record/cover.jpg?size=96&v=nested-revision"));
  });

  it("draws a sticky header and one row per song, in the list's colour", () => {
    const { container } = render(<PlaylistSongTable {...props()} />);
    const header = container.querySelector(".retro-song-table__header");
    expect(header?.parentElement?.className).toBe("playlist-song-stack");
    expect(header?.parentElement?.firstElementChild?.className).toBe("playlist-table-tools");
    expect(container.querySelectorAll(".retro-song-table__body > li")).toHaveLength(2);
    const root = container.querySelector<HTMLElement>(".retro-song-table.playlist-songs");
    expect(root?.style.getPropertyValue("--song-table-head")).toBe("#ff0");
  });

  it("hides a column with the root class, never by dropping cells", () => {
    act(() => setColumnVisible("album", false));
    const { container } = render(<PlaylistSongTable {...props()} />);
    expect(container.querySelector(".retro-song-table")?.className).toContain("song-table--hide-album");
    expect(container.querySelector(".retro-song-table__header .song-col--album")).not.toBeNull();
  });

  it("plays on double-click and says why a list is empty", () => {
    const p = props();
    const { container, rerender, getByText } = render(<PlaylistSongTable {...p} />);
    fireEvent.doubleClick(container.querySelector("li")!);
    expect(p.onPlay).toHaveBeenCalledWith(tracks[0]);
    rerender(<PlaylistSongTable {...p} tracks={[]} isEmpty />);
    expect(getByText("Esta playlist está vacía")).toBeTruthy();
    rerender(<PlaylistSongTable {...p} tracks={[]} isEmpty={false} />);
    expect(getByText("Ninguna canción coincide con la búsqueda")).toBeTruthy();
  });
});

// jsdom has no PointerEvent constructor or layout. Drive real DOM handlers
// with pointer-shaped mouse events and deterministic table geometry.
function pointer(target: Element | Window, type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(target, event);
}
function geometry(container: HTMLElement) {
  const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top, toJSON: () => ({}) });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("retro-song-table__header") || this.classList.contains("playlist-song-stack")) return rect(60, 40);
    const rows = [...container.querySelectorAll("li[data-path]")];
    const index = rows.indexOf(this);
    return index >= 0 ? rect(100 + index * 40, 40) : rect(0, 600);
  });
}

describe("playlist dragging", () => {
  afterEach(() => vi.restoreAllMocks());
  it("hides the grips when sorted, filtered or not editable, explaining the header", () => {
    const p = { ...props(), canEdit: true, onMove: vi.fn() };
    const { container, rerender } = render(<PlaylistSongTable {...p} />);
    expect(container.querySelectorAll(".playlist-reorder__grip")).toHaveLength(2);
    rerender(<PlaylistSongTable {...p} sortField="title" />);
    expect(container.querySelector(".playlist-reorder__grip")).toBeNull();
    expect(container.querySelector('[title="Quita el orden por columna para mover canciones"]')).toBeTruthy();
    rerender(<PlaylistSongTable {...p} searchQuery="One" />);
    expect(container.querySelector(".playlist-reorder__grip")).toBeNull();
    expect(container.querySelector('[title="Quita la búsqueda para mover canciones"]')).toBeTruthy();
    rerender(<PlaylistSongTable {...p} canEdit={false} />);
    expect(container.querySelector(".playlist-reorder__grip")).toBeNull();
  });
  it("only lifts from the grip, dims sources, draws a line and moves a selection as one block", () => {
    const songs = [...tracks, { path: "/m/third.mp3", title: "Third" }, { path: "/m/fourth.mp3", title: "Fourth" }];
    const p = { ...props(), tracks: songs, canEdit: true, isSelected: (track: typeof tracks[number]) => tracks.some(song => song.path === track.path), onMove: vi.fn() };
    const { container } = render(<PlaylistSongTable {...p} />);
    geometry(container);
    pointer(container.querySelector("li[data-path]")!, "pointerdown", 20, 120);
    pointer(window, "pointermove", 100, 270);
    expect(document.querySelector(".playlist-reorder__ghost")).toBeNull();
    pointer(container.querySelector(".playlist-reorder__grip")!, "pointerdown", 20, 120);
    pointer(window, "pointermove", 100, 270);
    expect(container.querySelectorAll(".playlist-reorder__lifted")).toHaveLength(2);
    expect(document.querySelector(".playlist-reorder__ghost")?.textContent).toContain("2One More Time+ 1");
    expect(container.querySelector(".playlist-reorder__drop")).toBeTruthy();
    pointer(window, "pointerup", 100, 270);
    expect(p.onMove).toHaveBeenCalledExactlyOnceWith([songs[2], songs[3], ...tracks], tracks);
    expect(document.querySelector(".playlist-reorder__ghost")).toBeNull();
    fireEvent.click(container.querySelector(".playlist-reorder__grip")!);
    expect(p.onSelect).not.toHaveBeenCalled();
  });
  it("cancels with Escape, ignores a no-op drop, and preserves click and double-click", () => {
    const p = { ...props(), canEdit: true, onMove: vi.fn() };
    const { container } = render(<PlaylistSongTable {...p} />);
    geometry(container);
    const grip = container.querySelector(".playlist-reorder__grip")!;
    pointer(grip, "pointerdown", 20, 120);
    pointer(window, "pointermove", 25, 120);
    pointer(window, "pointerup", 25, 120);
    expect(p.onMove).not.toHaveBeenCalled();
    pointer(grip, "pointerdown", 20, 120);
    pointer(window, "pointermove", 100, 190);
    fireEvent.keyDown(window, { key: "Escape" });
    pointer(window, "pointerup", 100, 190);
    expect(p.onMove).not.toHaveBeenCalled();
    expect(document.querySelector(".playlist-reorder__ghost")).toBeNull();
    pointer(grip, "pointerdown", 20, 120);
    pointer(window, "pointerup", 20, 120);
    fireEvent.click(grip);
    expect(p.onSelect).toHaveBeenCalledWith(tracks[0], expect.anything());
    fireEvent.doubleClick(grip);
    expect(p.onPlay).toHaveBeenCalledWith(tracks[0]);
  });
});

describe("playlist drag boundaries and scrolling", () => {
  afterEach(() => vi.restoreAllMocks());
  it("moves an unselected row alone and cancels on filter changes", () => {
    const p = { ...props(), canEdit: true, isSelected: (track: typeof tracks[number]) => track.path === tracks[1].path, onMove: vi.fn() };
    const { container, rerender } = render(<PlaylistSongTable {...p} />);
    geometry(container);
    const grip = () => container.querySelector(".playlist-reorder__grip")!;
    pointer(grip(), "pointerdown", 20, 120);
    pointer(window, "pointermove", 100, 190);
    pointer(window, "pointerup", 100, 190);
    expect(p.onMove).toHaveBeenCalledExactlyOnceWith([...tracks].reverse(), [tracks[0]]);
    p.onMove.mockClear();
    pointer(grip(), "pointerdown", 20, 120);
    pointer(window, "pointermove", 100, 190);
    rerender(<PlaylistSongTable {...p} searchQuery="One" />);
    pointer(window, "pointerup", 100, 190);
    expect(p.onMove).not.toHaveBeenCalled();
    expect(document.querySelector(".playlist-reorder__ghost")).toBeNull();
  });
  it("scrolls on animation frames near the edges and stops when cancelled", () => {
    const p = { ...props(), canEdit: true, onMove: vi.fn() };
    const { container } = render(<div style={{ overflowY: "auto" }}><PlaylistSongTable {...p} /></div>);
    geometry(container);
    let frame: FrameRequestCallback;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frame = callback; return 42; });
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    const scroll = container.firstElementChild!;
    pointer(container.querySelector(".playlist-reorder__grip")!, "pointerdown", 20, 120);
    pointer(window, "pointermove", 100, 590);
    act(() => frame(16));
    expect(scroll.scrollTop).toBeGreaterThan(0);
    const at = scroll.scrollTop;
    pointer(window, "pointermove", 100, 10);
    act(() => frame(32));
    expect(scroll.scrollTop).toBeLessThan(at);
    fireEvent.pointerCancel(window);
    expect(cancel).toHaveBeenCalledWith(42);
    expect(document.querySelector(".playlist-reorder__ghost")).toBeNull();
    expect(p.onMove).not.toHaveBeenCalled();
  });
});

describe("playlist virtual drag path", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("reorders a scrolled window using global indexes, survives SongRows' wrapper, and reveals by index", () => {
    const songs = Array.from({ length: 400 }, (_, index) => ({ path: `/m/${index}.mp3`, title: `Song ${index}` }));
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top, toJSON: () => ({}) });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("playlist-song-stack") ? 80 : this.classList.contains("retro-song-table__row") ? 44 : 400;
    });
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(18000);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const page = this.closest<HTMLElement>(".test-scroll");
      if (this.classList.contains("playlist-song-rows")) return rect(300 - (page?.scrollTop ?? 0), 17600);
      if (this.classList.contains("playlist-song-stack")) return rect(0, 80);
      if (this.classList.contains("retro-song-table__row")) return rect(100 + [...this.parentElement!.children].indexOf(this) * 44, 44);
      if (this.tagName === "UL") return rect(100, 800);
      return rect(0, 600);
    });
    const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; });
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
    const onMove = vi.fn();
    const handle = React.createRef<import("../albums/SongRows").SongRowsHandle>();
    function Page() {
      const scroll = React.useRef<HTMLDivElement>(null);
      return <div className="test-scroll" ref={scroll} style={{ overflowY: "auto" }}><PlaylistSongTable {...props()} tracks={songs} scrollRef={scroll} rowsRef={handle} initialOffset={4400} canEdit onMove={onMove} /></div>;
    }
    const { container } = render(<Page />);
    const list = container.querySelector<HTMLUListElement>("ul[data-first-index]")!;
    const first = Number(list.dataset.firstIndex);
    expect(first).toBeGreaterThan(0);
    expect(first % 2).toBe(0);
    expect(list.children.length).toBeLessThan(100);
    expect(list.parentElement?.parentElement?.classList.contains("playlist-song-rows")).toBe(true);
    expect(list.style.transform).toBe(`translateY(${first * 44}px)`);
    expect(container.querySelector<HTMLElement>(".test-scroll")?.style.getPropertyValue("--stack-h")).toBe("80px");
    let frame: FrameRequestCallback;
    const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation(callback => { frame = callback; return 42; });
    const scroll = container.querySelector<HTMLElement>(".test-scroll")!;
    const beforeScroll = scroll.scrollTop;
    expect(beforeScroll).toBe(4400);
    pointer(list.querySelectorAll(".playlist-reorder__grip")[2], "pointerdown", 20, 210);
    pointer(window, "pointermove", 100, 90);
    act(() => frame(16));
    // 90 is near the stack's bottom (80), but far from the scroller's top.
    expect(scroll.scrollTop).toBeLessThan(beforeScroll);
    fireEvent.pointerCancel(window);
    raf.mockRestore();
    const moving = songs[first + 2];
    pointer(list.querySelectorAll(".playlist-reorder__grip")[2], "pointerdown", 20, 210);
    pointer(window, "pointermove", 100, 362);
    pointer(window, "pointerup", 100, 362);
    const expected = [...songs];
    expected.splice(first + 2, 1);
    expected.splice(first + 5, 0, moving);
    expect(onMove).toHaveBeenCalledExactlyOnceWith(expected, [moving]);
    scrollTo.mockClear();
    act(() => handle.current?.scrollToIndex(300));
    expect(scrollTo).toHaveBeenCalled();
    expect(scrollTo.mock.calls.at(-1)?.[0].top).toBeGreaterThan(12000);
  // Drives the real 400-song virtual table, geometry, drag, scroll and reveal path.
  }, 30000);
});

it.each(['list', 'grid'] as const)('renders stale playlist songs without Deleted badges in %s view', async mode => {
  await i18n.changeLanguage('en');
  setLibraryRoot('/m');
  setLibraryPresence([{ tracks: [tracks[0]] }]);
  setPlaylistViewMode(mode);
  try {
    const { container } = render(<PlaylistSongTable {...props()} />);
    expect(container.querySelector('[data-kind="deleted"]')).toBeNull();
    expect(container.querySelector('[data-path="/m/Homework/02.mp3"]')).toBeInTheDocument();
    expect(screen.queryByText('Deleted')).toBeNull();
  } finally { act(() => { setLibraryPresence(); setLibraryRoot(null); setPlaylistViewMode('list'); }); await i18n.changeLanguage('es'); }
});
