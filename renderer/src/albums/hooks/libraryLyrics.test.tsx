import { useRef } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { DataProvider } from "../../data";
import { installFakeBackend, type FakeBackend, type ResponseSpec } from "../../data/test-support";
import { refreshLyricStates } from "../../lyrics/lyricStates";
import LibraryToolbar from "../LibraryToolbar";
import { useLibraryView } from "./useLibraryView";

beforeAll(() => { HTMLElement.prototype.scrollIntoView = vi.fn(); });
const songs = ["synced", "plain", "pending", "none", "instrumental"].map((state, i) => ({
  relPath: `Artista∕Álbum/${state} #${i}.mp3`, title: state,
  bpm: 100, mood: "calm", analysis: { camelot: "8A" },
}));
const albums = [{ path: "/music/Album", album: "Album", artist: "Artist", genre: "Pop", tracks: songs }];
const states = Object.fromEntries(songs.map(song => [song.relPath, song.title]));
const counts = { synced: 1, plain: 1, pending: 1, none: 1, instrumental: 1, queued: 0 };
let backend: FakeBackend;
let client: QueryClient;
function setup(response: () => ResponseSpec | Promise<ResponseSpec> = () => ({ status: 200, json: { states, counts } })) {
  backend = installFakeBackend({ respond: req => {
    if (req.pathname === "/api/lyrics/states") return response();
    if (req.pathname === "/api/stems") return { status: 200, json: { splits: [
      { album: "Artista∕Álbum", file: "synced #0.mp3" },
      { album: "Artista∕Álbum", file: "pending #2.mp3" },
    ] } };
  } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
}
function Wrapper({ children }: { children: React.ReactNode }) { return <DataProvider queryClient={client}>{children}</DataProvider>; }
afterEach(() => { cleanup(); client?.clear(); backend?.restore(); localStorage.clear(); });

it("counts the scoped songs, composes with Stems and the other facets, and clears both filters", async () => {
  // An index entry outside this scope must never inflate the displayed counts.
  setup(() => ({ status: 200, json: { states: { ...states, "Other/extra.mp3": "plain" }, counts: { ...counts, plain: 2 } } }));
  const { result } = renderHook(() => useLibraryView(albums), { wrapper: Wrapper });
  await waitFor(() => expect(result.current.lyricCounts).toEqual({ all: 5, with: 2, without: 3 }));
  await waitFor(() => expect(result.current.stems.counts.ready).toBe(2));
  act(() => result.current.setLyric("with"));
  expect(result.current.tracks.map(t => t.title).sort()).toEqual(["plain", "synced"]);
  act(() => result.current.setLyric("without"));
  expect(result.current.tracks.map(t => t.title).sort()).toEqual(["instrumental", "none", "pending"]);
  act(() => result.current.setPistas("ready"));
  expect(result.current.lyricCounts).toEqual({ all: 2, with: 1, without: 1 });
  expect(result.current.tracks.map(t => t.title)).toEqual(["pending"]);
  expect(result.current.activeCount).toBe(2);
  act(() => result.current.setLyric("with"));
  expect(result.current.tracks.map(t => t.title)).toEqual(["synced"]);
  act(() => { result.current.setPistas("none"); result.current.setLyric("without"); });
  expect(result.current.lyricCounts).toEqual({ all: 3, with: 1, without: 2 });
  expect(result.current.tracks.map(t => t.title).sort()).toEqual(["instrumental", "none"]);
  act(() => {
    result.current.setPistas("ready"); result.current.setLyric("with");
    result.current.setArtist("Artist"); result.current.setAlbum("/music/Album");
    result.current.setGenre("Pop"); result.current.setMood("calm");
    result.current.setBpmPreset("mid"); result.current.setKey("8A");
    result.current.setSearch("pending");
  });
  expect(result.current.lyricCounts).toEqual({ all: 1, with: 0, without: 1 });
  expect(result.current.tracks).toHaveLength(0);
  act(() => result.current.setLyric("without"));
  expect(result.current.tracks.map(t => t.title)).toEqual(["pending"]);
  act(() => result.current.clearFilters());
  expect(result.current.tracks).toHaveLength(5);
  expect(result.current.activeCount).toBe(0);
  expect(result.current.lyricCounts).toEqual({ all: 5, with: 2, without: 3 });
});

it("shows ellipses during loading and resolves the counted dropdown beside Stems", async () => {
  let finish: (response: ResponseSpec) => void;
  setup(() => new Promise(resolve => { finish = resolve; }));
  function Library() {
    const view = useLibraryView(albums); const searchRef = useRef<HTMLInputElement>(null);
    return <LibraryToolbar view={view} searchRef={searchRef} scoped={false} canScope={false} onScope={vi.fn()} serverCount={5} mineCount={0} accountName="Cuenta" reloading={false} onReload={vi.fn()} />;
  }
  render(<Library />, { wrapper: Wrapper });
  const selects = screen.getAllByRole("button").filter(b => b.hasAttribute("aria-haspopup"));
  expect(selects.at(-2)).toHaveAttribute("aria-label", "Letra: Todas");
  expect(selects.at(-1)).toHaveAttribute("aria-label", "Pistas: Todas");
  fireEvent.click(screen.getByRole("button", { name: "Letra: Todas" }));
  expect(screen.getAllByRole("option").map(o => o.textContent)).toEqual(["Todas5", "Con letra…", "Sin letra…"]);
  fireEvent.click(screen.getByRole("option", { name: /Sin letra/ }));
  expect(screen.getByRole("button", { name: "Letra: Sin letra" })).toHaveTextContent("Sin letra …");
  await waitFor(() => expect(finish).toBeDefined());
  await act(async () => { finish({ status: 200, json: { states, counts } }); });
  expect(screen.getByRole("button", { name: "Letra: Sin letra" })).toHaveTextContent("Sin letra 3");
});

it.each([404, 500])("keeps failed index requests (%s) unknown instead of reporting zero", async status => {
  setup(() => ({ status }));
  const { result } = renderHook(() => useLibraryView(albums), { wrapper: Wrapper });
  await act(() => refreshLyricStates().catch(() => {}));
  expect(result.current.lyricCounts).toEqual({ all: 5, with: "…", without: "…" });
  act(() => result.current.setLyric("without"));
  expect(result.current.tracks).toHaveLength(0);
  act(() => result.current.setLyric("all"));
  expect(result.current.tracks).toHaveLength(5);
});

it("keeps missing keys and first-seen queued jobs unknown, then updates when results arrive", async () => {
  let current = { [songs[0].relPath]: "queued", [songs[1].relPath]: "plain" };
  setup(() => ({ status: 200, json: { states: current, counts } }));
  const { result, rerender } = renderHook(({ scope }) => useLibraryView(scope), { initialProps: { scope: albums }, wrapper: Wrapper });
  await act(() => refreshLyricStates());
  expect(result.current.lyricCounts).toEqual({ all: 5, with: "…", without: "…" });
  act(() => result.current.setLyric("without"));
  expect(result.current.tracks).toHaveLength(0);
  current = states;
  await act(() => refreshLyricStates());
  expect(result.current.lyricCounts).toEqual({ all: 5, with: 2, without: 3 });
  expect(result.current.tracks).toHaveLength(3);
  current = { ...states, [songs[0].relPath]: "queued", [songs[2].relPath]: "queued" };
  await act(() => refreshLyricStates());
  expect(result.current.lyricCounts).toEqual({ all: 5, with: 2, without: 3 });
  expect(result.current.tracks).toHaveLength(3);
  rerender({ scope: [{ ...albums[0], tracks: [songs[0], { ...songs[1], title: "Unkeyed", relPath: "" }] }] });
  expect(result.current.lyricCounts).toEqual({ all: 2, with: "…", without: "…" });
  rerender({ scope: [] });
  expect(result.current.lyricCounts).toEqual({ all: 0, with: 0, without: 0 });
});
