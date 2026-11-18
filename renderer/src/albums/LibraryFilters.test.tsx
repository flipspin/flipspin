import { useRef } from "react";
import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as matcher from "../search/match";
import { useLibraryView } from "./hooks/useLibraryView";
import LibraryFiltersToolbar from "./LibraryFiltersToolbar";
import { LibraryFiltersActive } from "./LibraryFilters";

vi.mock("../stems/libraryStems", async importOriginal => ({
  ...await importOriginal<typeof import("../stems/libraryStems")>(),
  useLibraryStems: () => ({ keys: new Set(), counts: { all: 3, ready: 0, none: 3 } }),
}));
vi.mock("../lyrics/lyricStates", async importOriginal => ({
  ...await importOriginal<typeof import("../lyrics/lyricStates")>(),
  useLyricStates: () => ({ states: {}, filterStates: { "Album/1.mp3": "none", "Album/2.mp3": "plain", "Album/3.mp3": "none" } }),
}));

const albums = [{ album: "Album", artist: "Artist", path: "/music/Album", genre: "Pop", tracks: [
  { path: "/music/Album/1.mp3", title: "One", bpm: 128, mood: "calm", analysis: { camelot: "8A" } },
  { path: "/music/Album/2.mp3", title: "Two", bpm: 125 },
  { path: "/music/Album/3.mp3", title: "Three", bpm: 100 },
] }];

function Library() {
  const view = useLibraryView(albums);
  const searchRef = useRef<HTMLInputElement>(null);
  return <>
    <LibraryFiltersToolbar view={view} searchRef={searchRef} scoped={false} canScope={false} onScope={vi.fn()}
      serverCount={3} mineCount={0} accountName="Cuenta" reloading={false} onReload={vi.fn()} />
    <LibraryFiltersActive view={view} count={view.tracks.length} total={3} />
    <output aria-label="resultados">{view.tracks.map(track => track.title).join(", ")}</output>
    <input aria-label="fuera" />
  </>;
}

beforeEach(() => {
  localStorage.clear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

async function pick(user: ReturnType<typeof userEvent.setup>, name: RegExp, option: RegExp) {
  await user.click(screen.getByRole("button", { name }));
  await user.click(screen.getByRole("option", { name: option }));
}

describe("Library filters", () => {
  it("opens all eight existing facets, filters real songs, removes one and clears the rest", async () => {
    const user = userEvent.setup();
    render(<Library />);
    expect(screen.queryByRole("group", { name: "Filtros activos" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^BPM:/ })).toBeNull();
    const trigger = screen.getByRole("button", { name: "Filtros" });
    await user.click(trigger);
    const popover = screen.getByRole("dialog", { name: "Filtros" });
    expect(within(popover).getAllByRole("button", { expanded: false })).toHaveLength(8);
    expect(within(popover).getByRole("button", { name: /^Stems:/ })).toBeInTheDocument();
    await pick(user, /^BPM:/, /Bailable/);
    expect(screen.getByRole("dialog", { name: "Filtros" })).toBeInTheDocument();
    expect(screen.getByLabelText("resultados")).toHaveTextContent("One, Two");
    await pick(user, /^Letra:/, /Sin letra/);
    expect(screen.getByLabelText("resultados")).toHaveTextContent(/^One$/);
    expect(trigger).toHaveTextContent("Filtros2");
    const active = screen.getByRole("group", { name: "Filtros activos" });
    expect(active).toHaveTextContent("BPM120–139");
    expect(active).toHaveTextContent("LetraSin letra");
    expect(active).toHaveTextContent("1 de 3");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Quitar filtro BPM" }));
    expect(active).not.toHaveTextContent("BPM");
    expect(screen.getByLabelText("resultados")).toHaveTextContent("One, Three");
    await user.click(screen.getByRole("button", { name: "Limpiar" }));
    expect(screen.queryByRole("group", { name: "Filtros activos" })).toBeNull();
    expect(trigger).toHaveTextContent(/^Filtros$/);
    expect(screen.getByLabelText("resultados")).toHaveTextContent("One, Two, Three");
  });

  it("dismisses the inner select first and then the filters popover without losing focus", async () => {
    const user = userEvent.setup();
    render(<Library />);
    await user.click(screen.getByRole("button", { name: "Filtros" }));
    await user.click(screen.getByRole("button", { name: /^BPM:/ }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Filtros" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^BPM:/ })).toHaveFocus();
    await user.click(screen.getByRole("textbox", { name: "fuera" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("textbox", { name: "fuera" })).toHaveFocus();
  });

  it("keeps the collapsible search separate from the eight facet count", () => {
    render(<Library />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar en la biblioteca" }), { target: { value: "One" } });
    expect(screen.getByLabelText("resultados")).toHaveTextContent(/^One$/);
    expect(screen.getByRole("button", { name: "Filtros" })).toHaveTextContent(/^Filtros$/);
    expect(screen.queryByRole("group", { name: "Filtros activos" })).toBeNull();
  });
});


describe("Library search ordering", () => {
  const listing = [{ album: "Future Nostalgia", artist: "Dua Lipa", path: "/dua", tracks: [
    { path: "/dua/1", title: "Superfuture", dateAdded: 5 },
    { path: "/dua/2", title: "Futureproof", dateAdded: 4 },
    { path: "/dua/3", title: "Future", dateAdded: 3 },
    { path: "/dua/4", title: "Canción", dateAdded: 2 },
  ] }];
  it("matches accents, multiple fields and reordered artist words", () => {
    const { result } = renderHook(() => useLibraryView(listing));
    act(() => result.current.setSearch("cancion"));
    expect(result.current.tracks.map(t => t.title)).toEqual(["Canción"]);
    act(() => result.current.setSearch("dua future"));
    expect(result.current.tracks).toHaveLength(4);
    act(() => result.current.setSearch("lipa dua"));
    expect(result.current.tracks).toHaveLength(4);
  });
  it("prepares fields once for a listing, then reuses them for each query", () => {
    const prepare = vi.spyOn(matcher, "prepareSearchDocument");
    const { result, rerender } = renderHook(({ albums }) => useLibraryView(albums), { initialProps: { albums: listing } });
    expect(prepare).toHaveBeenCalledTimes(4);
    act(() => result.current.setSearch("dua"));
    act(() => result.current.setSearch("dua future"));
    expect(prepare).toHaveBeenCalledTimes(4);
    rerender({ albums: [...listing] });
    expect(prepare).toHaveBeenCalledTimes(8);
  });
  it("ranks in default order, preserves explicit column sorts and their persisted choice", () => {
    // Put the search word only in titles to distinguish all match tiers.
    const songs = [{ ...listing[0], album: "Other", tracks: listing[0].tracks.slice(0, 3) }];
    const { result, unmount } = renderHook(() => useLibraryView(songs));
    act(() => result.current.setSearch("future"));
    expect(result.current.tracks.map(t => t.title)).toEqual(["Future", "Futureproof", "Superfuture"]);
    act(() => result.current.sortByColumn("title"));
    act(() => result.current.toggleSortDir());
    expect(result.current.tracks.map(t => t.title)).toEqual(["Superfuture", "Futureproof", "Future"]);
    act(() => result.current.setSortField("date"));
    expect(result.current.tracks.map(t => t.title)).toEqual(["Superfuture", "Futureproof", "Future"]);
    unmount();
    const next = renderHook(() => useLibraryView(songs));
    act(() => next.result.current.setSearch("future"));
    expect(next.result.current.tracks.map(t => t.title)).toEqual(["Superfuture", "Futureproof", "Future"]);
  });
});
