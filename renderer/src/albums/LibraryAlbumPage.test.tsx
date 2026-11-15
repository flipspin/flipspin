import { render } from "../library/tracks/songMenuTestSupport";
import { render as renderUi } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../data/hooks/use-library-missing", () => ({ useLibraryMissing: () => new Set<string>() }));

const mocks = vi.hoisted(() => ({
  checkOwnership: vi.fn(),
  moveTrack: vi.fn(),
  confirmReplace: vi.fn(),
  acquire: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
  openLibraryAlbum: vi.fn(),
  openMatch: vi.fn(),
}));

vi.mock("../browse/browseApi", () => ({
  checkOwnership: mocks.checkOwnership,
  search: vi.fn(async () => ({ albums: [{ title: "Discovery", artistName: "Daft Punk", ref: { provider: "deezer", id: "302127" } }] })),
  fetchAlbum: vi.fn(async () => ({ tracks: catalog })),
}));
vi.mock("../browse/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browse/resolve")>()),
  moveTrack: mocks.moveTrack,
  confirmReplace: mocks.confirmReplace,
}));
vi.mock("../browse/useAcquisition", () => ({ useAcquisition: () => ({ active: false, acquire: mocks.acquire }) }));
vi.mock("../state/useStatus", () => ({ useStatus: () => ({ showSuccess: mocks.showSuccess, showError: mocks.showError }) }));
vi.mock("@state/AudioPlayerContext", () => ({ useAudioPlayer: () => ({ play: vi.fn(), addToQueue: vi.fn(), addNextInQueue: vi.fn(), toggleShuffle: vi.fn() }) }));
vi.mock("@state/SettingsContext", () => ({ useSettings: () => ({}) }));
vi.mock("../library/tracks/useAddToPlaylistMenu", () => ({ useAddToPlaylistMenu: () => ({ refresh: vi.fn(), submenu: () => [] }) }));
vi.mock("./hooks/useAlbumActions", () => ({ useAlbumActions: () => ({ sendItems: () => [] }) }));
vi.mock("./AlbumTrackRow", () => ({ default: ({ track }: { track: { title: string } }) => <li>{track.title}</li> }));
vi.mock("../lyrics/LyricsModal", () => ({ default: () => null }));
vi.mock("../browse/navigationStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browse/navigationStore")>()),
  openLibraryAlbum: mocks.openLibraryAlbum,
}));
vi.mock("../plugins", () => ({ pluginTrackMenuItems: () => [] }));
vi.mock("../match/matchStore", async importOriginal => ({
  ...await importOriginal<typeof import('../match/matchStore')>(), openMatch: mocks.openMatch,
}));

import LibraryAlbumPage from "./LibraryAlbumPage";
import { masDe } from "./artistMatch";
// The shared "More from" cases: the same file the iPhone and Android suites read.
// contracts/ sits at the repo root, five levels up from this folder.
import contract from "../../../contracts/album-page.json";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

const catalog = [
  { title: "One More Time", artistName: "Daft Punk", trackPosition: 1, durationSeconds: 320 },
  { title: "Aerodynamic", artistName: "Daft Punk", trackPosition: 2, durationSeconds: 212 },
  { title: "Digital Love", artistName: "Daft Punk", trackPosition: 3, durationSeconds: 301 },
  { title: "Harder, Better, Faster, Stronger", artistName: "Daft Punk", trackPosition: 4, durationSeconds: 224 },
];
const album = {
  path: "/music/Discovery",
  mediaKey: "Discovery",
  album: "Discovery",
  artist: "Daft Punk",
  tracks: [{ path: "/music/Discovery/03.mp3", title: "Digital Love", track_number: 3 }],
};
const single = { title: "One More Time", album: "One More Time", path: "/music/One_More_Time/01.mp3", durationSeconds: 320 };
const radioEdit = { title: "Aerodynamic", album: "Discovery", path: "/music/Aero/02.mp3", durationSeconds: 170 };

async function openFullAlbum() {
  mocks.checkOwnership.mockResolvedValue([
    { owned: true, match: single },
    { owned: false, nearMatch: radioEdit },
    { owned: true, match: { title: "Digital Love", album: "Discovery", path: "/music/Discovery/03.mp3" } },
    { owned: false },
  ]);
  render(<LibraryAlbumPage id="/music/Discovery" albums={[album]} />);
  fireEvent.click(screen.getByRole("button", { name: "Mostrar álbum completo" }));
  await screen.findByRole("button", { name: "Mover «One More Time» aquí" });
}

describe("LibraryAlbumPage's full album", () => {
  // Loads the full album, renders its rows and opens the real ordered track menu.
  it('keeps song rows without overflow and preserves the right-click action order', async () => {
    await openFullAlbum();
    const row = screen.getByRole('button', { name: 'Mover «One More Time» aquí' }).closest('li')!;
    expect(row.querySelector('[aria-label="Más opciones"]')).toBeNull();
    fireEvent.contextMenu(row);
    expect(screen.getAllByRole('menuitem').slice(0, 3).map(item => item.textContent)).toEqual([
      'Reproducir', 'Reproducir a continuación', 'Añadir a la cola',
    ]);
  }, 20000);
  it("moves a song filed under another album into this one, instead of a «+» that gets nothing", async () => {
    await openFullAlbum();
    expect(screen.getByText("en «One More Time»")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Conseguir «One More Time»" })).toBeNull();

    mocks.moveTrack.mockResolvedValue({ success: true, path: "/music/Discovery/01.mp3" });
    const changed = vi.fn();
    window.addEventListener("library-changed", changed);
    fireEvent.click(screen.getByRole("button", { name: "Mover «One More Time» aquí" }));
    await waitFor(() => expect(mocks.showSuccess).toHaveBeenCalledWith("«One More Time» movida a «Discovery»"));
    window.removeEventListener("library-changed", changed);

    expect(mocks.moveTrack).toHaveBeenCalledWith({ path: single.path, albumDir: "Discovery", albumTitle: "Discovery", trackNumber: 1 });
    expect(changed).toHaveBeenCalledOnce();
    // Re-asked, so the row flips once the album list comes back.
    expect(mocks.checkOwnership).toHaveBeenCalledTimes(2);
  });

  it("puts Agregar and Descargar in the album header", async () => {
    await openFullAlbum();
    expect(screen.getByRole('button', { name: 'Agregar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Descargar' })).toBeInTheDocument();
  });

  it("swaps another cut for the catalog's only after the confirmation", async () => {
    await openFullAlbum();
    const swap = screen.getByRole("button", { name: "Cambiar «Aerodynamic» por esta versión" });

    mocks.confirmReplace.mockResolvedValueOnce(false);
    fireEvent.click(swap);
    await waitFor(() => expect(mocks.confirmReplace).toHaveBeenCalledWith(radioEdit));
    expect(mocks.acquire).not.toHaveBeenCalled();

    mocks.confirmReplace.mockResolvedValueOnce(true);
    fireEvent.click(swap);
    await waitFor(() => expect(mocks.acquire).toHaveBeenCalledWith([{ ...catalog[1], replaces: radioEdit.path }], undefined));
  });
});

describe("contracts/album-page.json", () => {
  it.each(contract.masDe)("$case", ({ album: a, albums: list, out }) => {
    expect(masDe(a, list).map((x) => x.path)).toEqual(out);
  });
});

describe("LibraryAlbumPage's «Más de»", () => {
  const homework = { path: "/music/Homework", album: "Homework", artist: "Daft Punk", tracks: [] };
  const other = { path: "/music/Motomami", album: "Motomami", artist: "Rosalía", tracks: [] };

  it("lists the artist's other albums after the songs, and a cover opens one", () => {
    render(<LibraryAlbumPage id="/music/Discovery" albums={[album, homework, other]} />);
    const head = screen.getByRole("button", { name: /Más de Daft Punk/ });
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("button", { name: "Abrir Motomami" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Abrir Homework" }));
    expect(mocks.openLibraryAlbum).toHaveBeenCalledWith(homework);
  });

  it("folds, and the fold is remembered by the next album", () => {
    render(<LibraryAlbumPage id="/music/Discovery" albums={[album, homework]} />);
    fireEvent.click(screen.getByRole("button", { name: /Más de Daft Punk/ }));
    expect(screen.queryByRole("button", { name: "Abrir Homework" })).toBeNull();
    cleanup();
    render(<LibraryAlbumPage id="/music/Homework" albums={[album, homework]} />);
    expect(screen.getByRole("button", { name: /Más de Daft Punk/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Abrir Discovery" })).toBeNull();
  });

  it("draws no section when no other album is the artist's", () => {
    render(<LibraryAlbumPage id="/music/Discovery" albums={[album, other]} />);
    expect(screen.queryByRole("button", { name: /Más de/ })).toBeNull();
  });

  it("draws neither catalog control while offline", () => {
    render(<LibraryAlbumPage id="/music/Discovery" albums={[album]} online={false} />);
    expect(screen.queryByRole("button", { name: "Mostrar álbum completo" })).toBeNull();
  });
});

describe('album MusicBrainz entry', () => {
  it('opens matching for the owner from the header menu', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(['me', 'profile'], { role: 'owner', isOwner: true });
    renderUi(<QueryClientProvider client={client}><LibraryAlbumPage id={album.path} albums={[album]} /></QueryClientProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Más opciones del álbum' }));
    const match = screen.getByRole('menuitem', { name: 'Buscar coincidencia en MusicBrainz…' });
    expect(match.querySelector('span')?.style.background).toBe('var(--teal)');
    fireEvent.click(match);
    expect(mocks.openMatch).toHaveBeenCalledWith({ albumKey: 'Discovery', title: 'Discovery' });
  });
  it('keeps the shared album actions for members without matching', () => {
    render(<LibraryAlbumPage id={album.path} albums={[album]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Más opciones del álbum' }));
    expect(screen.getByRole('menuitem', { name: /Descargar en este equipo/ })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: /Letras/ })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Buscar coincidencia en MusicBrainz…' })).toBeNull();
  });
});
