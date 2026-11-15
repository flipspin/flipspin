import { render } from "../tracks/songMenuTestSupport";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mocks = vi.hoisted(() => ({ play: vi.fn(), playlists: [{ name: "Dúa Gym", trackCount: 3 }], fallback: vi.fn(), rowState: {}, offline: false, role: "member" }));
vi.mock("@lib/playlistSummaries", () => ({ usePlaylistSummaries: () => mocks.playlists, fetchPlaylistSummaries: () => Promise.resolve(mocks.playlists) }));
vi.mock("@state/SettingsContext", () => ({ useSettings: () => ({ mode: "light", setMode: vi.fn() }) }));
vi.mock("@state/LibraryContext", () => ({ useLibrary: () => ({ baseDir: "" }) }));
vi.mock("@state/AudioPlayerContext", () => ({ useAudioPlayer: () => ({ play: mocks.play, selectedTrack: null }) }));
vi.mock("../../shell/ServerBadge", () => ({ openSettings: vi.fn(), useNestStatus: () => ({ label: "Nido", color: "var(--teal)", hint: "" }) }));
vi.mock("../../attention/useAttention", () => ({ useAttention: () => ({ data: null, refetch: vi.fn(), isFetching: false }) }));
vi.mock("../../data", () => ({ useCurrentUser: () => ({ data: { role: mocks.role } }), optionalBridge: () => null }));
vi.mock("../../downloads/DownloadsMenu", () => ({ default: () => null }));
vi.mock("../../offline/useOffline", () => ({ useOffline: () => mocks.offline }));
vi.mock("../../offline/OfflineLibrary", () => ({ useOfflineLibrary: () => ({ offline: false }) }));
vi.mock("../../acquisition/RowState", () => ({ useRowState: () => mocks.rowState, renderRowEnd: () => null }));
vi.mock("../../viz/vizStore", () => ({ closeViz: vi.fn(), toggleViz: vi.fn() }));
vi.mock("../../state/useStatus", () => ({ useStatus: () => ({ showSuccess: vi.fn(), showError: vi.fn() }) }));
vi.mock("../../lyrics/useLyricsMenu", () => ({ useLyricsMenu: () => [] }));
vi.mock("../../lyrics/lyricsStore", () => ({ closeLyrics: vi.fn(), lyricsKeyOf: () => null, openLyrics: vi.fn() }));

import Header from "../../shell/layout/header";
import LibrarySearchPage from "./LibrarySearchPage";
import { librarySearchHistory } from "./librarySearch";
import { readScopedSearches } from "../../browse/catalogSearchHistory";
import { queryKeys } from "../../data/keys";
import { currentRoute, getState, openLibrarySearch, push, reset, routeTitle } from "../../browse/navigationStore";
import { getRoute } from "../../shell/routeStore";
import { useGlobalKeys } from "../../shell/useGlobalKeys";
import CollapsibleSearch from "../../ui/components/CollapsibleSearch";
import appSource from "../../shell/App.tsx?raw";
import { closeTrackInfo } from "../tracks/trackInfoStore";
import { closeTrackTags } from "../tracks/trackTagsStore";
import { TrackTagsHost } from "../tracks/TrackTagsHost";
import { setHeaderTitle } from "../../shell/headerTitle";

const albums = [{ album: "Dúa Disco", artist: "Dua Lipa", path: "/music/disco", tracks: Array.from({ length: 6 }, (_, i) => ({
  path: `/music/disco/${i}.mp3`, title: `Song ${i}`, duration: 120,
})) }];
beforeEach(() => { localStorage.clear(); reset(); mocks.play.mockClear(); mocks.fallback.mockClear(); mocks.rowState = {}; mocks.offline = false; mocks.role = "member"; });
afterEach(() => { act(() => { reset(); closeTrackInfo(); closeTrackTags(); setHeaderTitle(null); }); vi.restoreAllMocks(); });

function Keys() {
  useGlobalKeys({ selectedTrack: null, lyricsOpen: false, setIsPlaying: vi.fn(), openLibrary: mocks.fallback });
  const [filter, setFilter] = useState("");
  return <CollapsibleSearch value={filter} onChange={setFilter} label="Filtro local" />;
}

describe("persistent shell search", () => {
  it.each(["home", "albums", "playlists", "dashboard", "settings", "plugin-page"])("is present on %s in both shell orientations", page => {
    const { rerender } = render(<Header activePage={page} albums={albums} />);
    expect(screen.getByRole("combobox")).toBeVisible();
    rerender(<Header activePage={page} albums={albums} portrait />);
    expect(screen.getByRole("combobox")).toBeVisible();
    expect(appSource).toContain('<Header activePage={activePage} albums={albums}');
  });
  it("keeps ⌘K and Ctrl+K global; typing stays in the dropdown and Escape clears and blurs", async () => {
    const user = userEvent.setup();
    render(<><Header albums={albums} /><Keys /></>);
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(input).toHaveFocus();
    await user.type(input, "dua");
    expect(input).toHaveValue("dua");
    expect(currentRoute()).toBeNull();
    expect(screen.getByRole("listbox", { name: "En tu biblioteca" })).toBeVisible();
    expect(readScopedSearches()).toEqual([]);
    await user.keyboard("{Escape}");
    expect(input).toHaveValue(""); expect(input).not.toHaveFocus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(input).toHaveFocus();
    expect(mocks.fallback).not.toHaveBeenCalled();
  });
  it("shows at most six local matches including all four kinds, then the Explore row; arrows and Enter open the selected artist", async () => {
    const user = userEvent.setup();
    render(<Header albums={albums} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "dua");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(7);
    expect(options.slice(0, 4).map(row => row.textContent)).toEqual(["Dua Lipa Artista", "Dúa Disco Álbum", "Song 0 Canción", "Dúa Gym Playlist"]);
    expect(options.at(-1)).toHaveTextContent('Buscar "dua" en Explorar⌘↵');
    await user.keyboard("{ArrowDown}");
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);
    await user.keyboard("{Enter}");
    expect(currentRoute()).toMatchObject({ kind: "library-artist", id: "Dua Lipa" });
    expect(readScopedSearches()[0]).toEqual({ query: "dua", scope: "library" });
  });
  it.each([1, 2, 3])("opens selected album, song or playlist row %s", async row => {
    const user = userEvent.setup();
    render(<Header albums={albums} />);
    await user.type(screen.getByRole("combobox"), "dua");
    for (let i = 0; i <= row; i++) await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    if (row === 1) expect(currentRoute()).toMatchObject({ kind: "library-album", id: "/music/disco" });
    if (row === 2) expect(mocks.play).toHaveBeenCalledWith(expect.objectContaining({ title: "Song 0" }), expect.objectContaining({ replaceQueue: true }));
    if (row === 3) expect(getRoute()).toMatchObject({ page: "playlists", playlist: "Dúa Gym" });
  });
  it("Enter with no row opens library results, including when no matches exist", async () => {
    const user = userEvent.setup();
    render(<Header albums={albums} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "dua{Enter}");
    expect(currentRoute()).toMatchObject({ kind: "library-search", query: "dua" });
    expect(getState().stack).toHaveLength(1);
    expect(routeTitle(currentRoute())).toBe("Buscar");
    await user.click(input); await user.clear(input); await user.type(input, "missing{Enter}");
    expect(currentRoute()).toMatchObject({ kind: "library-search", query: "missing" });
    expect(getState().stack).toHaveLength(1);
  });
  it.each(["shortcut", "keyboard row", "click"])("opens Explore for the same query via %s", async via => {
    const user = userEvent.setup();
    render(<Header albums={albums} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "dua");
    if (via === "shortcut") { await user.keyboard("{ArrowDown}"); fireEvent.keyDown(input, { key: "Enter", metaKey: true }); }
    if (via === "keyboard row") await user.keyboard("{ArrowUp}{Enter}");
    if (via === "click") await user.click(screen.getByRole("option", { name: /Buscar "dua" en Explorar/ }));
    expect(currentRoute()).toMatchObject({ kind: "search", query: "dua", mode: "full" });
    expect(readScopedSearches()[0]).toEqual({ query: "dua", scope: "explore" });
  });
  it.each(["dashboard", "album", "artist", "playlist", "search"])("starts in Explore from %s; empty Backspace removes its chip and Enter searches the library", async from => {
    if (from !== "dashboard") push({ kind: from, id: "1", title: "Catalog", ...(from === "search" ? { query: "dua" } : {}) });
    const user = userEvent.setup();
    const view = render(<Header activePage="dashboard" albums={albums} />);
    const input = screen.getByRole("combobox", { name: "Buscar en Explorar" });
    await user.click(input); await user.clear(input);
    expect(view.container.querySelector(".library-search__chip")).toHaveTextContent("Explorar");
    await user.type(input, "dua");
    expect(screen.getByRole("listbox", { name: "En Explorar" })).toBeVisible();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.clear(input); await user.keyboard("{Backspace}");
    expect(view.container.querySelector(".library-search__chip")).toBeNull();
    await user.type(input, "dua{Enter}");
    expect(currentRoute()).toMatchObject({ kind: "library-search", query: "dua" });
  });
  it("Enter in Explore scope opens catalog results; moving to another page resets the starting scope", async () => {
    const user = userEvent.setup();
    const view = render(<Header activePage="dashboard" albums={albums} />);
    await user.type(screen.getByRole("combobox"), "dua{Enter}");
    expect(currentRoute()).toMatchObject({ kind: "search", query: "dua" });
    act(() => reset());
    view.rerender(<Header activePage="albums" albums={albums} />);
    expect(screen.getByRole("combobox", { name: "Buscar en tu biblioteca" })).toHaveValue("");
  });
  it("keeps the Explore row dimmed offline with a reason, and blocks click, Enter and ⌘Enter", async () => {
    mocks.offline = true;
    const user = userEvent.setup();
    render(<Header albums={albums} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "dua");
    const explore = screen.getByRole("option", { name: /Sin conexión/ });
    expect(explore).toHaveAttribute("aria-disabled", "true");
    expect(explore).toHaveAttribute("title", "No disponible sin conexión");
    expect(explore).not.toHaveTextContent("⌘↵");
    await user.keyboard("{ArrowUp}{Enter}"); await user.click(explore);
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(currentRoute()).toBeNull();
    expect(readScopedSearches()).toEqual([]);
  });
  it("observes provider availability already in the shared cache without fetching it", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.server.providers(), [{ enabled: true, available: false, capabilities: ["search:albums"], unavailableReason: "Provider unavailable" }]);
    const user = userEvent.setup();
    render(<QueryClientProvider client={client}><Header albums={albums} /></QueryClientProvider>);
    await user.type(screen.getByRole("combobox"), "dua");
    expect(screen.getByRole("option", { name: /Sin conexión/ })).toHaveAttribute("title", "Provider unavailable");
    act(() => client.setQueryData(queryKeys.server.providers(), [{ enabled: true, available: true, capabilities: ["search:albums"] }]));
    expect(screen.getByRole("option", { name: /Buscar "dua" en Explorar/ })).toHaveAttribute("aria-disabled", "false");
    client.clear();
  });
  it("merges both legacy recent lists, shows scope words, removes entries, and reruns each in its scope", async () => {
    localStorage.setItem("krobi.recentLibrarySearches", JSON.stringify(["local old"]));
    localStorage.setItem("krobi.recentCatalogSearches", JSON.stringify(["catalog old"]));
    const user = userEvent.setup();
    render(<Header albums={albums} />);
    const input = screen.getByRole("combobox");
    await user.click(input);
    expect(screen.getByRole("option", { name: "local old Biblioteca" })).toBeVisible();
    await user.click(screen.getByRole("option", { name: "catalog old Explorar" }));
    expect(currentRoute()).toMatchObject({ kind: "search", query: "catalog old" });
    await user.click(input); await user.clear(input);
    await user.click(screen.getByRole("option", { name: "local old Biblioteca" }));
    expect(currentRoute()).toMatchObject({ kind: "library-search", query: "local old" });
    await user.click(input); await user.clear(input);
    await user.click(screen.getByRole("button", { name: "Borrar búsqueda catalog old" }));
    expect(readScopedSearches()).toEqual([{ query: "local old", scope: "library" }]);
    expect(input).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveAttribute("aria-activedescendant", screen.getByRole("option").id);
  });
  it("reruns a recent for the current results page without losing its query or adding history", async () => {
    const user = userEvent.setup();
    render(<Header albums={albums} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "dua{Enter}");
    await user.click(input); await user.clear(input);
    await user.click(screen.getByRole("option", { name: "dua Biblioteca" }));
    expect(input).toHaveValue("dua");
    expect(currentRoute()).toMatchObject({ kind: "library-search", query: "dua" });
    expect(getState().stack).toHaveLength(1);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
  it("clearing and Escape preserve the underlying page and its local filter", async () => {
    const user = userEvent.setup();
    act(() => push({ kind: "library-album", id: "/music/disco", title: "Disco" }));
    render(<><Header albums={albums} /><Keys /></>);
    const filter = screen.getByRole("searchbox", { name: "Filtro local" });
    fireEvent.change(filter, { target: { value: "my local filter" } });
    const input = screen.getByRole("combobox");
    await user.type(input, "dua");
    await user.click(screen.getByRole("button", { name: "Borrar la búsqueda" }));
    expect(currentRoute()).toMatchObject({ kind: "library-album", id: "/music/disco" });
    expect(input).toHaveValue(""); expect(input).toHaveFocus();
    expect(filter).toHaveValue("my local filter");
  });
});

describe("library results", () => {
  it("uses fixed group order and counts, highlights accents, shows four songs and reveals all N", async () => {
    const user = userEvent.setup();
    const { container } = render(<LibrarySearchPage albums={albums} query="dua" />);
    expect(screen.getAllByRole("region").map(group => group.getAttribute("aria-label"))).toEqual(["Artistas", "Canciones", "Álbumes", "Playlists"]);
    for (const [title, count] of [["Artistas", 1], ["Canciones", 6], ["Álbumes", 1], ["Playlists", 1]]) {
      expect(screen.getByRole("button", { name: `${title} ${count}` })).toHaveAttribute("aria-expanded", "true");
    }
    expect(screen.getByRole("status")).toHaveTextContent("9 resultados");
    expect(container.querySelectorAll(".retro-song-table__row")).toHaveLength(4);
    expect(container.querySelector(".cover-card__title .bg-\\[var\\(--coral\\)\\]" )?.textContent).toBe("Dúa");
    await user.click(screen.getByRole("button", { name: "Ver las 6" }));
    expect(container.querySelectorAll(".retro-song-table__row")).toHaveLength(6);
    expect(librarySearchHistory.readRecentSearches()).toEqual([]);
  });
  it("omits empty groups, matches every word across fields and saves only when a song is opened", async () => {
    const user = userEvent.setup();
    render(<LibrarySearchPage albums={albums} query="dua song 2" />);
    expect(screen.getAllByRole("region").map(group => group.getAttribute("aria-label"))).toEqual(["Canciones"]);
    expect(librarySearchHistory.readRecentSearches()).toEqual([]);
    await user.click(screen.getByRole("button", { name: "Reproducir Song 2" }));
    expect(mocks.play).toHaveBeenCalledWith(expect.objectContaining({ title: "Song 2", url_path: expect.any(String) }), expect.objectContaining({ replaceQueue: true, context: expect.any(Array) }));
    expect(librarySearchHistory.readRecentSearches()).toEqual(["dua song 2"]);
  });
  it("plays on a row click with the library queue and keeps unavailable rows disabled", async () => {
    const user = userEvent.setup();
    const view = render(<LibrarySearchPage albums={albums} query="dua" />);
    await user.click(screen.getByText("Song 1"));
    expect(mocks.play).toHaveBeenCalledTimes(1);
    const [song, options] = mocks.play.mock.calls[0];
    expect(song.title).toBe("Song 1");
    expect(song.album).not.toHaveProperty("tracks");
    expect(options.context).toHaveLength(6);
    expect(options.upcomingTracks).toHaveLength(4);
    mocks.play.mockClear(); mocks.rowState = { unavailable: true };
    view.unmount();
    render(<LibrarySearchPage albums={albums} query="dua" />);
    await user.click(screen.getByText("Song 1"));
    expect(screen.getByRole("button", { name: "Reproducir Song 1" })).toBeDisabled();
    expect(mocks.play).not.toHaveBeenCalled();
  });
  it("opens the existing song information dialog without playing or saving", async () => {
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    render(<QueryClientProvider client={client}><LibrarySearchPage albums={albums} query="dua" /></QueryClientProvider>);
    await user.click(screen.getByRole("button", { name: "Información de Song 0" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Song 0");
    expect(mocks.play).not.toHaveBeenCalled();
    expect(librarySearchHistory.readRecentSearches()).toEqual([]);
  });
  it("opens one shared song window from the search information and footer entry points", async () => {
    mocks.role = "owner";
    const user = userEvent.setup();
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
    render(<QueryClientProvider client={client}><LibrarySearchPage albums={albums} query="dua" /><TrackTagsHost /></QueryClientProvider>);
    await user.click(screen.getByRole("button", { name: "Información de Song 2" }));
    const dialog = screen.getByRole("dialog", { name: "Canción" });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(within(dialog).getByLabelText("Título")).toHaveValue("Song 2");
    expect(within(dialog).getByRole("button", { name: "Editar etiquetas" })).toBeDisabled();
    expect(mocks.play).not.toHaveBeenCalled();
  });
  it("persists independent group folds across remounts and query changes", async () => {
    const user = userEvent.setup();
    const view = render(<LibrarySearchPage albums={albums} query="dua" />);
    await user.click(screen.getByRole("button", { name: "Canciones 6" }));
    expect(screen.queryByRole("button", { name: "Reproducir Song 0" })).toBeNull();
    view.unmount();
    const next = render(<LibrarySearchPage albums={albums} query="song" />);
    expect(screen.getByRole("button", { name: "Canciones 6" })).toHaveAttribute("aria-expanded", "false");
    next.rerender(<LibrarySearchPage albums={albums} query="dua" />);
    expect(screen.getByRole("button", { name: "Artistas 1" })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Canciones 6" }));
    expect(screen.getByRole("button", { name: "Reproducir Song 0" })).toBeVisible();
  });
  it("opens existing album, artist and playlist pages and saves the search", async () => {
    const user = userEvent.setup();
    render(<LibrarySearchPage albums={albums} query="dua" />);
    await user.click(within(screen.getByRole("region", { name: "Artistas" })).getByRole("button", { name: /Dua Lipa/ }));
    expect(currentRoute()).toMatchObject({ kind: "library-artist", id: "Dua Lipa" });
    await user.click(within(screen.getByRole("region", { name: "Álbumes" })).getByRole("button", { name: /Dúa Disco/ }));
    expect(currentRoute()).toMatchObject({ kind: "library-album", id: "/music/disco" });
    await user.click(within(screen.getByRole("region", { name: "Playlists" })).getByRole("button", { name: /Dúa Gym/ }));
    expect(getRoute()).toMatchObject({ page: "playlists", playlist: "Dúa Gym" });
    expect(currentRoute()).toBeNull();
    expect(librarySearchHistory.readRecentSearches()).toEqual(["dua"]);
  });
  it("folds with the keyboard even if local storage is corrupt or denied", async () => {
    localStorage.setItem("krobi.librarySearch.collapsedGroups", "{");
    const user = userEvent.setup();
    render(<LibrarySearchPage albums={albums} query="dua" />);
    const artists = screen.getByRole("button", { name: "Artistas 1" });
    act(() => artists.focus());
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("denied"); });
    await user.keyboard("{Enter}");
    expect(artists).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(artists.getAttribute("aria-controls")!)).toHaveAttribute("hidden");
    expect(screen.getByRole("button", { name: "Canciones 6" })).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(artists).toHaveAttribute("aria-expanded", "true");
  });
  it("no results has one action into Explore with the complete query", async () => {
    const user = userEvent.setup();
    act(() => openLibrarySearch("khruangbin en vivo"));
    render(<LibrarySearchPage albums={albums} query="khruangbin en vivo" />);
    expect(screen.getByRole("status")).toHaveTextContent("No está en tu biblioteca");
    expect(screen.getAllByRole("button")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: 'Buscar "khruangbin en vivo" en Explorar' }));
    expect(currentRoute()).toMatchObject({ kind: "search", mode: "full", query: "khruangbin en vivo" });
  });
});
