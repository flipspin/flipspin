import { installTestClock, clockUser, waitForClock as waitFor } from '../test/test-clock'
import React, { useRef } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { PlaylistSongGrid } from "./PlaylistGrid";
import PlaylistSongTable from "./PlaylistSongTable";
import { setPlaylistViewMode } from "./playlistViewMode";
import { useSongSelection } from "../library/tracks/useSongSelection";
import type { SongRowsHandle } from "../albums/SongRows";
import type { PlaylistTrack } from "./playlistTracks";

installTestClock()
let user: ReturnType<typeof clockUser>
beforeEach(() => { user = clockUser() })


vi.mock("../data/hooks/use-library-missing", () => ({ useLibraryMissing: () => new Set<string>() }));

const tracks: PlaylistTrack[] = [
  { path: "/m/Discovery/01.mp3", title: "One More Time", artist: "Daft Punk", album: "Discovery" },
  { path: "/m/Homework/02.mp3", title: "Da Funk", album: { album: "Homework", artist: "Daft Punk" } },
  { path: "/m/Third/03.mp3", title: "Third", artist: "Another artist" },
];
const handlers = () => ({ onPlay: vi.fn(), onTogglePlay: vi.fn(), onContextMenu: vi.fn() });
function Grid({ songs = tracks, activePath = tracks[0].path, playing = true, menuPath = null, ...callbacks }: {
  songs?: PlaylistTrack[]; activePath?: string; playing?: boolean; menuPath?: string;
} & ReturnType<typeof handlers>) {
  const scroll = useRef<HTMLDivElement>(null);
  const selection = useSongSelection(songs);
  const albums = [
      { mediaKey: "Discovery", coverVersion: "v1" },
      { mediaKey: "Artist∕Record", coverVersion: "v2", tracks: [tracks[1]] },
  ];
  return <div ref={scroll} style={{ overflowY: "auto" }}>
    <output>{selection.count}</output>
    <PlaylistSongGrid tracks={songs} albums={albums} scrollRef={scroll} initialOffset={0} scrollPaddingStart={40} activePath={activePath}
      isPlaying={playing} menuPath={menuPath} isSelected={selection.isSelected} onSelect={selection.click} {...callbacks} />
  </div>;
}

const tableProps = () => ({
  tracks, isEmpty: false, headColor: null, headInk: null, sortField: null, sortDir: "asc", onSort: vi.fn(),
  searchQuery: "", activePath: tracks[0].path, isSelected: () => false, onSelect: vi.fn(), onOpenAnalysis: vi.fn(), ...handlers(),
});

afterEach(() => {
  act(() => setPlaylistViewMode("list"));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("playlist song grid", () => {
  it("keeps playlist order, uses versioned size=300 thumbs, shared cards, no number badge and text tooltips", () => {
    const { container } = render(<Grid {...handlers()} />);
    const cards = [...container.querySelectorAll("li[data-path]")];
    expect(cards.map(card => card.getAttribute("data-path"))).toEqual(tracks.map(track => track.path));
    expect(container.querySelector(".playlist-track-card__number")).toBeNull();
    expect(cards[0].querySelector("img")).toHaveAttribute("src", expect.stringContaining("/Discovery/cover.jpg?size=300&v=v1"));
    expect(cards[1].querySelector("img")).toHaveAttribute("src", expect.stringContaining("/Artist%E2%88%95Record/cover.jpg?size=300&v=v2"));
    expect(cards[0].querySelector(".cover-card__open")).toHaveAttribute("title", "One More Time");
    expect(within(cards[0] as HTMLElement).getByText("Daft Punk")).toHaveAttribute("title", "Daft Punk");
    expect(cards[0].querySelector("button button")).toBeNull();
    expect(cards[0].querySelector(".cover-card__open .cover-card__title")).toBeTruthy();
    expect(cards[0].querySelector(".cover-card__open .cover-card__disc")).toBeNull();
    fireEvent.error(cards[0].querySelector("img")!);
    expect(cards[0].querySelector("img")).toBeNull();
    expect(cards[0].querySelector(".cover-card__art")).toHaveTextContent("D");
  });

  it("plays from the primary button and double-click, pauses/resumes the current disc, and uses one menu callback", () => {
    const h = handlers();
    const { container, rerender } = render(<Grid {...h} />);
    const first = container.querySelector<HTMLElement>("li[data-path]")!;
    expect(first).toHaveAttribute("aria-current", "true");
    expect(first.querySelector(".krobi-disc")).toHaveClass("krobi-disc--spinning");
    fireEvent.click(within(first).getByRole("button", { name: "Pausar One More Time" }));
    expect(h.onTogglePlay).toHaveBeenCalledOnce();
    expect(h.onPlay).not.toHaveBeenCalled();
    rerender(<Grid {...h} playing={false} menuPath={tracks[0].path} />);
    fireEvent.click(within(first).getByRole("button", { name: "Reanudar One More Time" }));
    expect(h.onTogglePlay).toHaveBeenCalledTimes(2);
    fireEvent.click(first.querySelector(".cover-card__open")!);
    expect(h.onPlay).toHaveBeenLastCalledWith(tracks[0]);
    h.onPlay.mockClear();
    fireEvent.doubleClick(first);
    expect(h.onPlay).toHaveBeenCalledExactlyOnceWith(tracks[0]);
    fireEvent.contextMenu(first.querySelector(".cover-card")!, { clientX: 10, clientY: 20 });
    expect(within(first).queryByRole("button", { name: "Más opciones" })).toBeNull();
    expect(h.onContextMenu).toHaveBeenCalledOnce();
    expect(h.onContextMenu.mock.calls.every(([song]) => song === tracks[0])).toBe(true);
    expect(first.querySelector(".cover-card")).toHaveAttribute("data-menu-open", "true");
  });

  it("uses the list selection hook for Command/Ctrl and Shift without playing or selecting right-clicks/disc clicks", () => {
    const h = handlers();
    const { container } = render(<Grid {...h} />);
    const cards = [...container.querySelectorAll<HTMLElement>("li[data-path]")];
    fireEvent.click(cards[0].querySelector(".cover-card__open")!, { metaKey: true });
    fireEvent.click(cards[1].querySelector(".cover-card__open")!, { ctrlKey: true });
    expect(cards.map(card => card.getAttribute("aria-selected"))).toEqual(["true", "true", "false"]);
    fireEvent.click(cards[2].querySelector(".cover-card__open")!, { shiftKey: true });
    expect(cards.map(card => card.getAttribute("aria-selected"))).toEqual(["false", "true", "true"]);
    expect(h.onPlay).not.toHaveBeenCalled();
    expect(cards[1].querySelector(".cover-card__more")).toBeNull();
    fireEvent.contextMenu(cards[1].querySelector(".cover-card")!);
    expect(cards[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.click(cards[0].querySelector(".cover-card__disc")!);
    expect(cards[0]).toHaveAttribute("aria-selected", "false");
  });

  it("selects on a real mouse click and plays only once on double-click", async () => {
    const h = handlers();
    const { container } = render(<Grid {...h} />);
    const primary = container.querySelector<HTMLElement>(".cover-card__open")!;
    await user.click(primary);
    expect(container.querySelector("li[data-path]")).toHaveAttribute("aria-selected", "true");
    expect(h.onPlay).not.toHaveBeenCalled();
    await user.dblClick(primary);
    expect(h.onPlay).toHaveBeenCalledExactlyOnceWith(tracks[0]);
  });

  it("persists the bare toolbar switch across playlist unmounts, hides header/grips and preserves empty states", () => {
    const p = { ...tableProps(), canEdit: true, onMove: vi.fn() };
    const view = render(<PlaylistSongTable {...p} />);
    expect(view.container.querySelector(".playlist-reorder__grip")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Portadas" }));
    expect(localStorage.getItem("krobi.playlists.view")).toBe("grid");
    expect(screen.getByRole("button", { name: "Portadas" })).toHaveAttribute("aria-pressed", "true");
    expect(view.container.querySelector(".retro-song-table__header")).toBeNull();
    expect(view.container.querySelector(".playlist-reorder__grip")).toBeNull();
    expect(view.container.querySelector(".playlist-track-grid")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Portadas" }).closest(".playlist-song-stack")).toBeTruthy();
    view.unmount();
    const next = render(<PlaylistSongTable {...p} />);
    expect(next.container.querySelector(".playlist-track-grid")).toBeTruthy();
    next.rerender(<PlaylistSongTable {...p} tracks={[]} isEmpty />);
    expect(screen.getByText("Esta playlist está vacía")).toBeTruthy();
    next.rerender(<PlaylistSongTable {...p} tracks={[]} isEmpty={false} />);
    expect(screen.getByText("Ninguna canción coincide con la búsqueda")).toBeTruthy();
    next.rerender(<PlaylistSongTable {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Lista" }));
    expect(localStorage.getItem("krobi.playlists.view")).toBe("list");
    expect(next.container.querySelector(".retro-song-table__header")).toBeTruthy();
  });
});

function virtualGeometry() {
  let width = 634; // 4 x 140 + 3 x 14 + 2 x 16 padding
  let resize: () => void;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(60000);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("playlist-track-grid__song") ? 160 : 400;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = this.classList.contains("playlist-track-grid") ? 300 - (this.parentElement?.scrollTop ?? 0) : 0;
    return { top, bottom: top + 400, left: 0, right: width, width, height: 400, x: 0, y: top, toJSON() {} };
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {} unobserve() {} disconnect() {}
  });
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => ({
    overflowY: element.classList.contains("test-scroll") ? "auto" : "visible",
    paddingLeft: "16px", paddingRight: "16px", paddingTop: "16px",
  } as CSSStyleDeclaration));
  const scrollTo = vi.fn(function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top ?? 0; });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
  return { scrollTo, resize: (next: number) => { width = next; resize?.(); } };
}

describe("playlist grid virtualization", () => {
  it("renders whole through 60, measures the first row, windows above 60, restores with band margin and reveals a song's row", async () => {
    const geometry = virtualGeometry();
    const songs = Array.from({ length: 800 }, (_, index) => ({ path: `/m/Album/${index}.mp3`, title: `Song ${index}` }));
    const handle = React.createRef<SongRowsHandle>();
    function Page({ count }: { count: number }) {
      const scroll = useRef<HTMLDivElement>(null);
      return <div ref={scroll} className="test-scroll" style={{ overflowY: "auto" }}>
        <PlaylistSongGrid tracks={songs.slice(0, count)} scrollRef={scroll} rowsRef={handle} initialOffset={1720}
          scrollPaddingStart={40} activePath={null} isPlaying={false} isSelected={() => false} onSelect={vi.fn()} {...handlers()} />
      </div>;
    }
    const { container, rerender } = render(<Page count={60} />);
    expect(container.querySelectorAll("li[data-path]")).toHaveLength(60);
    expect(container.querySelector("[data-virtual]")).toBeNull();
    rerender(<Page count={61} />);
    await waitFor(() => expect(container.querySelector("[data-virtual]")).toBeTruthy());
    expect(container.querySelectorAll("li[data-path]").length).toBeLessThan(61);
    rerender(<Page count={800} />);
    const space = container.querySelector<HTMLElement>(".playlist-track-grid__space")!;
    await waitFor(() => expect(space.style.height).toBe(`${200 * 178 - 18}px`));
    const cards = container.querySelector<HTMLElement>("ul[data-first-index]")!;
    const first = Number(cards.dataset.firstIndex);
    expect(first).toBeGreaterThan(0);
    expect(first % 8).toBe(0); // even-start virtual rows, four cards each
    expect(cards.style.transform).toBe(`translateY(${first / 4 * 178}px)`);
    expect(container.querySelectorAll("li[data-path]").length).toBeLessThan(80);
    expect(container.querySelector("li[data-path]")).toHaveAttribute("data-path", songs[first].path);
    act(() => handle.current?.scrollToIndex(700));
    expect(geometry.scrollTo).toHaveBeenCalled();
    expect(geometry.scrollTo.mock.calls.at(-1)?.[0].top).toBeGreaterThan(29000);
    act(() => geometry.resize(340)); // two columns, same measured card height
    await waitFor(() => expect(space.style.height).toBe(`${400 * 178 - 18}px`));
  });
});
