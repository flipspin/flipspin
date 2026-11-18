import { installTestClock, clockUser, waitForClock as waitFor } from '../../test/test-clock'
import { TrackInfoHost } from "./TrackInfoModal";
import { closeTrackInfo, openTrackInfo } from "./trackInfoStore";
import { render } from "./songMenuTestSupport";
import { act, fireEvent, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import i18n from "../../i18n";
import AlbumTrackRow from "../../albums/AlbumTrackRow";
import LibraryAlbumPage from "../../albums/LibraryAlbumPage";
import LibraryArtistPage from "../../albums/LibraryArtistPage";
import LibrarySearchPage from "../search/LibrarySearchPage";
import PlaylistSongTable from "../../playlists/PlaylistSongTable";
import SongTableHeader from "./SongTableHeader";
import { _resetForTest, emptySongColumns, getState, setColumnVisible, setColumnOrder, songTableGridStyle, songTableRootClass, useSongTableColumns } from "./songTableColumns";
import css from "../../styles/retro-song-table.css?raw";

installTestClock()


vi.mock("../../browse/browseApi", async original => ({
  ...await original<typeof import("../../browse/browseApi")>(),
  search: vi.fn(async () => ({ albums: [{ title: "Record", artistName: "Artist", ref: { provider: "catalog", id: "record" } }] })),
  fetchAlbum: vi.fn(async () => ({ tracks: [{ title: "Song", trackPosition: 1 }, { title: "Missing song", trackPosition: 2 }] })),
  checkOwnership: vi.fn(async () => [{ owned: true, match: { path: "/music/Record/song.mp3" } }, { owned: false }]),
}));
vi.mock("@state/AudioPlayerContext", () => ({ useAudioPlayer: () => ({ play: vi.fn(), addToQueue: vi.fn(), addNextInQueue: vi.fn(), toggleShuffle: vi.fn() }) }));
vi.mock("../../browse/useAcquisition", () => ({ useAcquisition: () => ({ active: false, acquire: vi.fn() }) }));
vi.mock("../../state/useStatus", () => ({ useStatus: () => ({}) }));
vi.mock("./useAddToPlaylistMenu", () => ({ useAddToPlaylistMenu: () => ({ refresh: vi.fn(), submenu: () => [] }) }));
vi.mock("../../plugins", () => ({ pluginTrackMenuItems: () => [] }));
vi.mock("../../lyrics/lyricStates", async original => ({ ...await original<typeof import("../../lyrics/lyricStates")>(), useLyricStates: () => ({ states: {} }) }));

const track = { path: "/music/Record/song.mp3", title: "Song", artist: "Artist", key: "3A", keySource: "computed", bpm: 120, bpmSource: "computed", duration: 180 };
const album = { path: "/music/Record", album: "Record", artist: "Artist", tracks: [track] };
const rowProps = {
  album, index: 0, number: 1, selected: false, isActive: false, onPlay: vi.fn(),
  language: undefined, searchQuery: undefined, highlightMatches: undefined, onSelect: undefined,
  onOpenAlbum: undefined, onOpenArtist: undefined, playList: undefined, playAlbum: undefined,
  onDownload: undefined, onOpenAnalysis: undefined, onContextMenu: undefined,
};

function Table({ onOpenAnalysis, song = track }: { onOpenAnalysis?: typeof openTrackInfo; song?: typeof track & { keyEstimated?: boolean; bpmEstimated?: boolean } }) {
  const columns = useSongTableColumns();
  return <div className={`retro-song-table ${songTableRootClass(columns)}`}>
    <SongTableHeader onSort={vi.fn()} />
    <ul><AlbumTrackRow {...rowProps} track={song} onOpenAnalysis={onOpenAnalysis} /></ul>
  </div>;
}

function cellIds(element: Element) {
  return [...element.children].map(cell => [...cell.classList].find(name => name.startsWith("song-col--")) ?? (cell.classList.contains("song-row__num") ? "song-col--num" : "acquire-row-end"));
}

afterEach(async () => { act(() => { _resetForTest(); closeTrackInfo(); }); await act(() => i18n.changeLanguage("es")); });

describe("Key column", () => {
  // Renders and rerenders each full song-table surface while checking every header and cell.
  it.each(["library", "playlist", "search", "album", "artist"])("keeps %s header and row cells in step when shown and hidden", surface => {
    const { container } = render(surface === "library" ? <Table /> : surface === "album" ? <LibraryAlbumPage id={album.path} albums={[album]} online={false} /> : surface === "artist" ? <LibraryArtistPage name="Artist" albums={[album]} /> : surface === "search" ? <LibrarySearchPage albums={[album]} query="Song" /> :
      <PlaylistSongTable tracks={[track]} isEmpty={false} headColor={null} headInk={null} sortField={null} sortDir="asc" onSort={vi.fn()} searchQuery="" activePath={null} isSelected={() => false} onSelect={vi.fn()} onPlay={vi.fn()} onOpenAnalysis={vi.fn()} onContextMenu={vi.fn()} />);
    const root = container.querySelector(".retro-song-table")!;
    const header = root.querySelector(".retro-song-table__header")!;
    const row = root.querySelector(".retro-song-table__row")!;
    const ids = cellIds(header);
    const order = [...getState().order].reverse();
    act(() => setColumnOrder(order));
    const template = songTableGridStyle(order)["--sc-template"];
    expect(header).toHaveStyle({ "--sc-template": template });
    expect(row).toHaveStyle({ "--sc-template": template });
    expect(ids).toHaveLength(13);
    expect(cellIds(row)).toEqual(ids);
    expect(ids.indexOf("song-col--key") + 1).toBe(ids.indexOf("song-col--bpm"));
    expect(root).not.toHaveClass("song-table--hide-key");
    expect(row.querySelector(".song-col--key")).toHaveTextContent("3A · Si♭ menor");
    fireEvent.click(within(root as HTMLElement).getByRole("button", { name: "Elegir columnas" }));
    const checkbox = screen.getByRole("checkbox", { name: /^Tono$/ });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(root).toHaveClass("song-table--hide-key");
    expect(cellIds(header)).toEqual(ids);
    expect(cellIds(row)).toEqual(ids);
    act(() => setColumnVisible("key", true));
    expect(root).not.toHaveClass("song-table--hide-key");
  }, 20000);

  it("keeps catalog-only album rows aligned with the header and owned rows", async () => {
    const { container } = render(<LibraryAlbumPage id={album.path} albums={[album]} />);
    fireEvent.click(screen.getByRole("button", { name: "Mostrar álbum completo" }));
    await waitFor(() => expect(container.querySelector(".song-row--missing")).toBeTruthy());
    const root = container.querySelector(".retro-song-table")!;
    const ids = cellIds(root.querySelector(".retro-song-table__header")!);
    const order = [...getState().order].reverse();
    act(() => setColumnOrder(order));
    for (const grid of root.querySelectorAll(".song-grid")) expect(grid).toHaveStyle({ ...songTableGridStyle(order) });
    for (const row of root.querySelectorAll(".retro-song-table__row")) expect(cellIds(row)).toEqual(ids);
    act(() => setColumnVisible("key", false));
    expect(root).toHaveClass("song-table--hide-key");
    for (const row of root.querySelectorAll(".retro-song-table__row")) expect(cellIds(row)).toEqual(ids);
  });

  it.each(["computed", "tag", "fixed", "estimated", "missing"])("renders %s with the shared analysis presentation", state => {
    const { container } = render(<ul><AlbumTrackRow {...rowProps} track={{ ...track, key: state === "missing" ? null : "3A", keyEstimated: state === "estimated", keySource: state === "estimated" ? "computed" : state }} /></ul>);
    const cell = container.querySelector(".song-col--key")!;
    expect(within(cell as HTMLElement).queryByRole("button")).toBeNull();
    if (state === "missing") {
      expect(within(cell as HTMLElement).getByRole("img", { name: "Aún sin analizar" })).toBeTruthy();
      expect(cell.querySelector(".analysis-value")).toBeNull();
    } else {
      expect(cell).toHaveTextContent("3A · Si♭ menor");
      expect(Boolean(cell.querySelector(".analysis-value--estimated"))).toBe(state === "estimated");
      if (state === "estimated") {
        expect(cell).toHaveTextContent("≈");
        expect(cell.querySelector(".analysis-source")).toBeNull();
      } else {
        expect(cell.querySelector(`.analysis-source--${state}`)).toBeTruthy();
      }
    }
  });

  it("uses the resolved key for availability, never stale computed data", () => {
    for (const key of [null, undefined, "", "  "]) expect(emptySongColumns([{ path: "x", key, analysis: { camelot: "3A" } }])).toContain("key");
    expect(emptySongColumns([{ path: "x" }, track])).not.toContain("key");
    expect(emptySongColumns([{ path: "x", key: "B♭ minor", keyEstimated: true }])).not.toContain("key");
    expect(getState().hidden).toEqual([]);
  });

  it("translates the heading, key name and picker hint into English", async () => {
    await act(() => i18n.changeLanguage("en"));
    const onSort = vi.fn();
    render(<><SongTableHeader onSort={onSort} /><ul><AlbumTrackRow {...rowProps} track={track} /></ul></>);
    expect(screen.getByText("3A · B♭ minor")).toBeTruthy();
    const heading = screen.getByRole("button", { name: "Key" });
    fireEvent.keyDown(heading, { key: "Enter" });
    expect(onSort).toHaveBeenCalledWith("key");
    fireEvent.click(screen.getByRole("button", { name: "Choose columns" }));
    expect(screen.getByRole("checkbox", { name: /^Key$/ })).toBeChecked();
  });

  it("collapses the Key grid track and both cells with BPM at narrow widths", () => {
    expect(css).toContain(".song-table--hide-key .song-col--key,");
    expect(css).toContain(".song-table--hide-key .song-grid { --sc-key: 0px; }");
    expect(css).toMatch(/@container \(max-width: 940px\) \{\s*\.song-grid \{ --sc-key: 0px; --sc-bpm: 0px; --sc-analysis: 0px; \}\s*\.song-col--key,\s*\.song-col--bpm,/);
  });
});

// Opens and closes the real song window through pointer and keyboard on each table surface.
it.each(["library", "playlist", "search", "album", "artist"].flatMap(surface => [false, true].map(estimated => ({ surface, estimated }))))("opens song info from $surface analysis columns (estimated: $estimated) with pointer and keyboard", async ({ surface, estimated }) => {
  const song = { ...track, keyEstimated: estimated, bpmEstimated: estimated }
  const record = { ...album, tracks: [song] }
  const user = clockUser()
  const select = vi.fn(), play = vi.fn()
  const { container } = render(<div onClick={select} onDoubleClick={play}>
    {surface === "library" ? <Table song={song} onOpenAnalysis={openTrackInfo} /> : surface === "album" ? <LibraryAlbumPage id={album.path} albums={[record]} online={false} /> : surface === "artist" ? <LibraryArtistPage name="Artist" albums={[record]} /> : surface === "search" ? <LibrarySearchPage albums={[record]} query="Song" /> :
      <PlaylistSongTable tracks={[song]} isEmpty={false} headColor={null} headInk={null} sortField={null} sortDir="asc" onSort={vi.fn()} searchQuery="" activePath={null} isSelected={() => false} onSelect={select} onPlay={play} onOpenAnalysis={openTrackInfo} onContextMenu={vi.fn()} />}
    {(surface === "library" || surface === "playlist") && <TrackInfoHost />}
  </div>)
  for (const column of ["key", "bpm"]) {
    const button = within(container.querySelector(`.retro-song-table__row .song-col--${column}`)! as HTMLElement).getByRole("button", { name: `Abrir información de la canción · ${estimated ? "Estimación de Flipspin" : "Cálculo de Flipspin"}` })
    for (const activate of [() => user.click(button), async () => { button.focus(); await user.keyboard("{Enter}") }, async () => { button.focus(); await user.keyboard(" ") }]) {
      await activate()
      const dialog = await waitFor(() => screen.getByRole("dialog", { name: "Canción" }))
      expect(within(dialog).getByText("Song", { exact: true })).toBeInTheDocument()
      expect(select).not.toHaveBeenCalled()
      expect(play).not.toHaveBeenCalled()
      act(() => closeTrackInfo())
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    }
  }
}, 20000)
