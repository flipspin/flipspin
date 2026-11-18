import { installTestClock, waitForClock as waitFor } from '../test/test-clock'
import { setLibraryPresence } from '../library/trackPresence';
import { render } from "../library/tracks/songMenuTestSupport";
import React, { useState } from "react";
import i18n from "../i18n";
import { act, fireEvent, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("../data/hooks/use-library-missing", () => ({ useLibraryMissing: () => new Set<string>() }));
import PlaylistView from "./PlaylistView";
import { focusSearch } from "../library/tracks/searchShortcut";
import { useHeaderTitleOverride } from "../shell/headerTitle";
import css from "../styles/retro-song-table.css?raw";
import { putPlaylistTracks } from "./playlistApi";
import { setPlaylistViewMode } from "./playlistViewMode";

installTestClock()


const songs = [
  { path: "a", title: "Linen Spiral" },
  { path: "b", title: "Ceramic Steps" },
  { path: "c", title: "Paper Lantern" },
];
const identity = vi.hoisted(() => ({ status: "ready", me: { id: "u1", role: "member", source: "token" } }));
const showError = vi.hoisted(() => vi.fn());
const player = vi.hoisted(() => ({
  play: vi.fn(), addNextInQueue: vi.fn(), addToQueue: vi.fn(), setIsPlaying: vi.fn(),
  selectedTrack: null as { path: string } | null, isPlaying: true,
}));
vi.mock("@state/identityStore", async (original) => ({ ...(await original<typeof import("@state/identityStore")>()), useIdentity: () => identity }));
vi.mock("@state/AudioPlayerContext", () => ({ useAudioPlayer: () => player }));
vi.mock("@state/SettingsContext", () => ({ useSettings: () => ({}) }));
vi.mock("../state/useStatus", () => ({ useStatus: () => ({ status: null, showInfo: vi.fn(), showSuccess: vi.fn(), showError, clear: vi.fn() }) }));
vi.mock("./playlistApi", () => ({ putPlaylistTracks: vi.fn() }));
vi.mock("./hooks/usePlaylistData", () => ({ usePlaylistData: () => {
  const [playlistTracks, setPlaylistTracks] = useState(songs);
  return { playlists: [], loadedFor: "Workshop", selectedPlaylist: { name: "Workshop", owner: "u1", created: "2026-10-23", modified: "2026-11-08" }, setSelectedPlaylist: vi.fn(), playlistTracks, setPlaylistTracks, loadPlaylists: vi.fn().mockResolvedValue(undefined), loadPlaylistTracks: vi.fn() };
} }));
vi.mock("./hooks/usePlaylistTransfer", () => ({ usePlaylistTransfer: () => ({ handleRefreshPlaylist: vi.fn() }) }));
vi.mock("../library/tracks/useAddToPlaylistMenu", () => ({ useAddToPlaylistMenu: () => ({ submenu: () => [], refresh: vi.fn() }) }));
vi.mock("../lyrics/useLyricsMenu", () => ({ useLyricsMenu: () => [] }));
vi.mock("../library/tracks/TrackInfoModal", () => ({ default: () => null, TrackInfoHost: () => null }));
vi.mock("../albums/TrackTagsModal", () => ({ default: () => null }));
vi.mock("../lyrics/LyricsModal", () => ({ default: () => null }));

function openMove(row: Element) {
  fireEvent.contextMenu(row, { clientX: 100, clientY: 200 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Mover" }));
}

// Renders the full playlist and drives selection through the real removal toolbar.
it('shows the counted file action in the playlist selection toolbar only for an owner', () => {
  identity.me.role = 'owner';
  try {
    const { container } = render(<PlaylistView albums={[]} selectedPlaylistName="Workshop" />);
    fireEvent.click(container.querySelector('[data-path="a"]')!);
    fireEvent.click(container.querySelector('[data-path="b"]')!, { ctrlKey: true });
    const action = screen.getByRole('button', { name: 'Eliminar archivo del nido… (2)' });
    expect(action).toHaveClass('playlist-table-tool--danger');
    expect(action.previousElementSibling).toHaveAttribute('role', 'separator');
    expect(action.closest('.playlist-table-tools__removals')).toBeInTheDocument();
  } finally { identity.me.role = 'member'; }
}, 20000);

describe("playlist covers integration", () => {
  afterEach(() => {
    act(() => setPlaylistViewMode("list"));
    player.selectedTrack = null;
    player.play.mockClear();
    player.setIsPlaying.mockClear();
  });

  // Renders the playlist grid, selects a range and opens the real track menu.
  it("replaces the toolbar with the selection bar and opens the real song menu for the selected run", () => {
    const { container } = render(<PlaylistView albums={[]} selectedPlaylistName="Workshop" />);
    fireEvent.click(screen.getByRole("button", { name: "Portadas" }));
    const first = container.querySelector('[data-path="a"] .cover-card__open')!;
    const last = container.querySelector('[data-path="c"] .cover-card__open')!;
    fireEvent.click(first, { metaKey: true });
    expect(screen.getByText("1 seleccionada")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Portadas" })).toBeNull();
    fireEvent.mouseDown(last, { shiftKey: true });
    fireEvent.click(last, { shiftKey: true });
    expect(screen.getByText("3 seleccionadas")).toBeTruthy();
    fireEvent.contextMenu(container.querySelector('[data-path="c"]')!, { clientX: 100, clientY: 200 });
    expect(screen.getByRole("menuitem", { name: "Quitar 3 de la playlist" })).toBeTruthy();
    fireEvent.keyDown(container.querySelector(".playlist-page")!, { key: "Escape" });
  }, 20000);

  // Renders the full card grid and exercises playback controls and queue replacement.
  it("threads current playback and pause/resume to the shared card and double-clicks into the playlist queue", () => {
    player.selectedTrack = songs[1];
    const { container } = render(<PlaylistView albums={[]} selectedPlaylistName="Workshop" />);
    fireEvent.click(screen.getByRole("button", { name: "Portadas" }));
    fireEvent.click(screen.getByRole("button", { name: "Pausar Ceramic Steps" }));
    expect(player.setIsPlaying).toHaveBeenCalledOnce();
    expect(player.setIsPlaying.mock.calls[0][0](true)).toBe(false);
    fireEvent.doubleClick(container.querySelector('[data-path="b"]')!);
    expect(player.play).toHaveBeenCalledWith(expect.objectContaining({ path: "b" }), expect.objectContaining({
      replaceQueue: true, source: { kind: "playlist", name: "Workshop" },
      upcomingTracks: [expect.objectContaining({ path: "c" })],
    }));
  }, 20000);
});

describe("Listas reorder integration", () => {
  beforeEach(() => {
    identity.me.id = "u1";
    vi.mocked(putPlaylistTracks).mockReset().mockResolvedValue(new Response(null, { status: 200 }));
    showError.mockClear();
  });
  it("moves the clicked song through the real submenu and announces its new position", async () => {
    const { container } = render(<PlaylistView albums={[]} selectedPlaylistName="Workshop" />);
    openMove(container.querySelector('[data-path="b"]')!);
    fireEvent.click(screen.getByRole("menuitem", { name: "Al final" }));
    await waitFor(() => expect(container.querySelector(".playlist-reorder__live")?.textContent).toBe("Ceramic Steps movida a la posición 3 de 3"));
    expect(putPlaylistTracks).toHaveBeenCalledExactlyOnceWith("Workshop", [songs[0], songs[2], songs[1]]);
    expect([...container.querySelectorAll("li[data-path]")].map(row => row.getAttribute("data-path"))).toEqual(["a", "c", "b"]);
  });
  it("uses the selection for the menu and announces the block", async () => {
    const { container } = render(<PlaylistView albums={[]} selectedPlaylistName="Workshop" />);
    fireEvent.click(container.querySelector('[data-path="a"]')!);
    fireEvent.click(container.querySelector('[data-path="b"]')!, { ctrlKey: true });
    openMove(container.querySelector('[data-path="b"]')!);
    expect(screen.getByRole("menuitem", { name: "Al principio" }).getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Abajo" }));
    await waitFor(() => expect(container.querySelector(".playlist-reorder__live")?.textContent).toBe("2 canciones movidas a la posición 2 de 3"));
    expect(putPlaylistTracks).toHaveBeenCalledExactlyOnceWith("Workshop", [songs[2], songs[0], songs[1]]);
  });
  it("uses one permission rule for removal and hides moving for another member", () => {
    identity.me.id = "u2";
    const { container } = render(<PlaylistView albums={[]} selectedPlaylistName="Workshop" />);
    expect(container.querySelector(".playlist-reorder__grip")).toBeNull();
    fireEvent.contextMenu(container.querySelector('[data-path="b"]')!, { clientX: 100, clientY: 200 });
    expect(screen.queryByRole("menuitem", { name: "Mover" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Quitar de la playlist" }).getAttribute("aria-disabled")).toBe("true");
  });
});

function HeaderProbe() {
  const title = useHeaderTitleOverride();
  return <output data-testid="header">{title && typeof title === "object" && title.collapsed ? title.name : "Playlists"}</output>;
}

describe("playlist scrolling and toolbar", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("uses a single unclipped sticky stack and replaces its toolbar in selection", async () => {
    const { container } = render(<PlaylistView albums={[]} selectedPlaylistName="Workshop" />);
    const stack = container.querySelector(".playlist-song-stack")!;
    expect(stack.children[0].className).toBe("playlist-table-tools");
    expect(stack.children[1].className).toContain("retro-song-table__header");
    expect(css).toContain("overflow-anchor: none; scroll-padding-top: var(--stack-h, 0px)");
    expect(css).toContain("overflow: visible;\n  container-type: normal;");
    expect(container.querySelector(".playlist-enter")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Seleccionar canciones" }));
    expect(screen.getByText("0 seleccionadas")).toBeTruthy();
    fireEvent.click(container.querySelector('[data-path="a"]')!);
    expect(screen.getByText("1 seleccionada")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Seleccionar canciones" })).toBeNull();
    fireEvent.keyDown(container.querySelector(".playlist-page")!, { key: "Escape" });
    expect(screen.getByRole("button", { name: "Seleccionar canciones" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Seleccionar canciones" }));
    act(() => { expect(focusSearch()).toBe(true); });
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
    expect(screen.queryByText("0 seleccionadas")).toBeNull();
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Ordenar" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Título" }));
    expect(container.querySelector("[data-sorted]")?.textContent).toBe("Título");
    fireEvent.click(screen.getByRole("button", { name: "Ordenar" }));
    await act(() => i18n.changeLanguage("en"));
    expect(screen.getByRole("button", { name: "Sort" })).toHaveAttribute("title", "Sort");
    expect(screen.getByRole("menu", { name: "Sort" })).toBeVisible();
    await act(() => i18n.changeLanguage("es"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Orden de la playlist" }));
    expect(container.querySelector("[data-sorted]")).toBeNull();
    fireEvent.contextMenu(container.querySelector(".retro-song-table__header")!);
    expect(screen.getByRole("dialog", { name: "Columnas de la tabla" })).toBeTruthy();
  // Exercises selection, search, sorting, two languages and the real column dialog.
  }, 20_000);
  it("toggles the strip only across the 16px sentinel and restores before paint on return", () => {
    let callback: IntersectionObserverCallback;
    const observe = vi.fn();
    const disconnect = vi.fn();
    vi.stubGlobal("IntersectionObserver", class {
      constructor(cb: IntersectionObserverCallback, options: IntersectionObserverInit) {
        callback = cb;
        expect(options.threshold).toEqual([0, 1]);
      }
      observe = observe;
      disconnect = disconnect;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const scroll = this.closest<HTMLElement>(".playlist-page")?.scrollTop ?? 0;
      const top = this.classList.contains("playlist-band__title") ? 80 - scroll : this.classList.contains("playlist-band-anchor") ? -scroll : 0;
      const height = this.classList.contains("playlist-band__title") ? 40 : 0;
      return { top, bottom: top + height, left: 0, right: 600, width: 600, height, x: 0, y: top, toJSON: () => ({}) };
    });
    const { container, unmount } = render(<><HeaderProbe /><PlaylistView albums={[]} selectedPlaylistName="Workshop" /></>);
    const page = container.querySelector<HTMLElement>(".playlist-page")!;
    const sentinel = container.querySelector<HTMLElement>(".playlist-title-sentinel")!;
    expect(sentinel.style.top).toBe("120px");
    expect(observe).toHaveBeenCalledWith(sentinel);
    expect(screen.getByTestId("header").textContent).toBe("Playlists");
    const crossing = (ratio: number, bottom: number) => act(() => callback([{ target: sentinel, isIntersecting: ratio > 0, intersectionRatio: ratio, boundingClientRect: { bottom }, rootBounds: { top: 0 } } as unknown as IntersectionObserverEntry], {} as IntersectionObserver));
    crossing(0, -1);
    expect(page.dataset.collapsed).toBe("true");
    expect(screen.getByTestId("header").textContent).toBe("Workshop");
    crossing(0.5, 8);
    expect(page.dataset.collapsed).toBe("true");
    crossing(1, 16);
    expect(page.dataset.collapsed).toBe("false");
    page.scrollTop = 250;
    fireEvent.scroll(page);
    unmount();
    expect(disconnect).toHaveBeenCalled();
    const returned = render(<><HeaderProbe /><PlaylistView albums={[]} selectedPlaylistName="Workshop" /></>);
    const restored = returned.container.querySelector<HTMLElement>(".playlist-page")!;
    expect(restored.scrollTop).toBe(250);
    expect(restored.dataset.collapsed).toBe("true");
    expect(screen.getByTestId("header").textContent).toBe("Workshop");
    restored.scrollTop = 0;
    fireEvent.scroll(restored);
  });
});

it('playlist play-all builds its context and upcoming queue without deleted songs', () => {
  setLibraryPresence([{ tracks: [songs[0], songs[2]] }]);
  player.play.mockClear();
  try {
    render(<PlaylistView albums={[]} selectedPlaylistName="Workshop" />);
    fireEvent.click(screen.getByRole('button', { name: 'Reproducir' }));
    expect(player.play).toHaveBeenCalledOnce();
    const [first, options] = player.play.mock.calls[0];
    expect(first.path).toBe('a');
    expect(options.context.map(track => track.path)).toEqual(['a', 'c']);
    expect(options.upcomingTracks.map(track => track.path)).toEqual(['c']);
  } finally { act(() => setLibraryPresence()); }
});
