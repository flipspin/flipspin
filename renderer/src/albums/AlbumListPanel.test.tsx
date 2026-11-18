import { render } from "../library/tracks/songMenuTestSupport";
import React from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AlbumListPanel from "./AlbumListPanel";
import { _resetForTest } from "../library/tracks/songTableColumns";
import type { LibraryView } from "./LibraryToolbar";
import type { ListedTrack } from "../home/decorateTrack";
import type { LyricState } from "../lyrics/lyricStates";

// Keep the real panel, header, picker and rows; unrelated library actions and
// filters do not need a backend for these list-availability transitions.
vi.mock("../acquisition/removeActions", () => ({ useRemoveActions: () => [], withRemoveActions: (items) => items }));
vi.mock("../library/tracks/useAddToPlaylistMenu", () => ({ useAddToPlaylistMenu: () => ({ submenu: () => [], refresh: vi.fn() }) }));
vi.mock("../lyrics/useLyricsMenu", () => ({ useLyricsMenu: () => [] }));
vi.mock("../ui/components/SelectionBar", () => ({ default: () => null }));
vi.mock("./LibraryFiltersToolbar", () => ({ default: () => null }));
vi.mock("./LibraryFilters", () => ({ LibraryFiltersActive: () => null }));
vi.mock("./LibraryFiltersStack", () => ({ useLibraryScrollStack: () => ({ scrollMargin: 0, stackHeight: 0 }) }));
vi.mock("./hooks/useLibraryScope", () => ({ useLibraryScope: (tracks: ListedTrack[], albums: unknown[]) => ({ tracks, albums }) }));
vi.mock("../data/hooks/use-library-missing", () => ({ useLibraryMissing: () => new Set<string>() }));

// The closed lyrics window now also reads playback for tap-to-sync.
vi.mock("@state/AudioPlayerContext", () => ({ useAudioPlayer: () => ({
  audioRef: { current: null }, nowPlaying: null, isPlaying: false,
}) }));

const props = {
  isPlaying: false, setIsPlaying: vi.fn(), selectedTrack: null, play: vi.fn(),
  decorateTrack: vi.fn(), highlightMatches: (text: string) => text,
  addToQueue: vi.fn(), addNextInQueue: vi.fn(), onOpenAnalysis: vi.fn(),
};
const albums = [];
function view(tracks: ListedTrack[], states: Record<string, LyricState> = {}): LibraryView {
  return { tracks, sortedAlbums: albums, albumIdOf: () => "", filters: { search: "", lyric: "all" },
    sort: { field: null, dir: "asc" }, layout: "list", lyricStates: { states }, stems: { counts: { all: tracks.length } },
  } as unknown as LibraryView;
}

describe("Library empty columns", () => {
  afterEach(() => act(() => _resetForTest()));
  it("restores genre and lyric columns when data arrives and hides them again for a filtered list", () => {
    const blank = [{ path: "/music/album/blank.mp3", title: "Blank" }];
    const { container, rerender } = render(<AlbumListPanel {...props} view={view(blank)} />);
    const root = container.querySelector(".retro-song-table")!;
    expect(root).toHaveClass("song-table--hide-genre", "song-table--hide-lyrics");
    expect(container.querySelectorAll(".song-col--genre")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Elegir columnas" }));
    expect(screen.getByRole("checkbox", { name: /Género/ })).toBeDisabled();
    const filled = [...blank, { path: "/music/album/filled.mp3", title: "Filled", genre: "Rock" }];
    rerender(<AlbumListPanel {...props} view={view(filled, { "album/filled.mp3": "plain" })} />);
    expect(root).not.toHaveClass("song-table--hide-genre");
    expect(root).not.toHaveClass("song-table--hide-lyrics");
    // Lyrics opens only with the lyric filter on (its 140 px track overflowed the card otherwise).
    expect(root).not.toHaveClass("song-table--lyrics");
    expect(container.querySelectorAll(".song-col--genre")).toHaveLength(3);
    expect(screen.getByRole("checkbox", { name: /Género/ })).toBeEnabled();
    expect(screen.getByRole("checkbox", { name: /Letra/ })).toBeEnabled();
    rerender(<AlbumListPanel {...props} view={view(blank, { "album/filled.mp3": "plain" })} />);
    expect(root).toHaveClass("song-table--hide-genre", "song-table--hide-lyrics");
    expect(container.querySelectorAll(".song-col--genre")).toHaveLength(2);
    expect(screen.getByRole("checkbox", { name: /Género/ })).toBeDisabled();
  });
});
