import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LibraryStats from "./LibraryStats";
import type { ListedAlbum } from "./decorateTrack";
import type { PlayHistory } from "@lib/playHistory";
import i18n from "../i18n";

const player = vi.hoisted(() => ({ play: vi.fn() }));
const device = vi.hoisted(() => ({ history: {} as PlayHistory }));
vi.mock("@state/AudioPlayerContext", () => ({ useAudioPlayer: () => player }));
vi.mock("@lib/playHistory", () => ({ usePlayHistory: () => device.history }));

const albums: ListedAlbum[] = [{ artist: "Uno", album: "Disco", path: "/music/Disco", year: 1999, genre: "Rock", tracks: [
  { path: "/music/Disco/1.mp3", title: "A", bpm: 120, key: "8A", duration: 180, mood: "upbeat", analysis: { energy: .8 } },
  { path: "/music/Disco/2.mp3", title: "B", bpm: 125, key: "7A", duration: 200, mood: "calm", analysis: { energy: .2 } },
  { path: "/music/Disco/3.mp3", title: "C", bpm: 130, key: "9A", duration: 200 },
  { path: "/music/Disco/4.mp3", title: "D", bpm: 90, key: "8B", duration: 300 },
  { path: "/music/Disco/5.mp3", title: "E", bpm: 90, key: "9B", duration: 300 },
] }];
const card = () => screen.getByRole("article");
const open = (name: string) => fireEvent.click(within(screen.getByRole("navigation")).getByRole("button", { name }));

beforeEach(async () => { player.play.mockClear(); device.history = {}; await i18n.changeLanguage("es"); });

describe("Tu biblioteca story interactions", () => {
  // Builds 1,234 tracks and renders every statistics card in both regional languages.
  it("formats every card's song and play counts with the selected regional language", async () => {
    await i18n.changeLanguage("es-MX");
    const tracks = Array.from({ length: 1234 }, (_, i) => ({ ...albums[0].tracks![0], path: `/music/${i}.mp3` }));
    device.history = { "/music/0.mp3": { n: 2856, at: 0 } };
    render(<LibraryStats albums={[{ ...albums[0], tracks }]} />);
    expect(screen.getByTitle(/^1,234 canciones ·/)).toHaveClass("tb-pager");
    for (const name of ["Tempo", "Tono", "Ánimo", "Épocas", "Géneros"]) {
      open(name);
      expect(within(card()).getByText(/^1,234 canciones/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Reproducir 1,234" })).toBeEnabled();
    }
    expect(within(card()).getByText("1,234")).toBeInTheDocument();
    open("Escuchas");
    expect(within(card()).getByText("2,856 reproducciones")).toBeInTheDocument();
    expect(within(card()).getByText("2,856")).toBeInTheDocument();
    expect(within(card()).getByRole("button", { name: "Uno · 2,856 reproducciones" })).toBeInTheDocument();
  }, 20000);

  it("plays exactly the picked bin, replacing the queue, and retains picks across cards", () => {
    render(<LibraryStats albums={albums} />);
    fireEvent.click(within(card()).getByRole("button", { name: "120–130 BPM · 2 canciones" }));
    fireEvent.click(screen.getByRole("button", { name: "Reproducir 2" }));
    expect(player.play).toHaveBeenCalledWith(expect.objectContaining({ path: "/music/Disco/1.mp3" }), { replaceQueue: true, upcomingTracks: [expect.objectContaining({ path: "/music/Disco/2.mp3" })] });
    open("Tono"); open("Tempo");
    expect(within(card()).getByRole("button", { name: "120–130 BPM · 2 canciones" })).toHaveAttribute("aria-pressed", "true");
  });
  it("uses 24 keyboard accessible SVG petals and queues the selected key plus three neighbours", () => {
    render(<LibraryStats albums={albums} />); open("Tono");
    const wheel = screen.getByRole("group", { name: "Canciones por tono, rueda Camelot" });
    expect(within(wheel).getAllByRole("button")).toHaveLength(24);
    const petal = within(wheel).getByRole("button", { name: "8A · la menor · 1 canción" });
    expect(petal.tagName).toBe("path");
    expect(petal).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(petal, { key: "Enter" });
    expect(petal).toHaveAttribute("aria-pressed", "true");
    const neighbour = within(wheel).getByRole("button", { name: "7A · re menor · 1 canción" });
    fireEvent.keyDown(neighbour, { key: " " });
    expect(neighbour).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(wheel).getByRole("button", { name: "8A · la menor · 1 canción" }));
    expect(screen.getByText("1 canción · mezcla con 7A 9A 8B")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reproducir 4" }));
    expect(player.play.mock.calls[0][0].path).toBe("/music/Disco/1.mp3");
    expect(player.play.mock.calls[0][1].upcomingTracks.map(t => t.path)).toEqual(["/music/Disco/2.mp3", "/music/Disco/3.mp3", "/music/Disco/4.mp3"]);
  });
  it("navigates by arrows, keyboard and dot focus; mood chips change the selected songs", () => {
    render(<LibraryStats albums={albums} />);
    fireEvent.click(screen.getByRole("button", { name: "Carta siguiente" }));
    expect(card()).toHaveAttribute("aria-label", "Tono");
    fireEvent.keyDown(card(), { key: "ArrowRight" });
    expect(card()).toHaveAttribute("aria-label", "Ánimo");
    fireEvent.click(screen.getByRole("button", { name: "animado" }));
    expect(screen.getByText("50%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reproducir 1" }));
    expect(player.play.mock.calls[0][0].path).toBe("/music/Disco/1.mp3");
    act(() => within(screen.getByRole("navigation")).getByRole("button", { name: "Géneros" }).focus());
    expect(card()).toHaveAttribute("aria-label", "Géneros");
  });
  it("opens Settings → Análisis for missing keys and Explore for an empty library", () => {
    const event = vi.fn(); window.addEventListener("krobi-show-settings", event);
    const { rerender } = render(<LibraryStats albums={[{ tracks: [{ path: "/x" }] }]} />); open("Tono");
    expect(screen.getByText("0 de 1 canción")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Detectar tonos" }));
    expect(event.mock.calls[0][0].detail).toEqual({ section: "analisis" });
    window.removeEventListener("krobi-show-settings", event);
    const explore = vi.fn(); rerender(<LibraryStats albums={[]} onOpenExplore={explore} />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir Explorar" })); expect(explore).toHaveBeenCalledOnce();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });
  it("has no play action without history and defaults to the artist with the most plays", () => {
    const { rerender } = render(<LibraryStats albums={albums} />); open("Escuchas");
    expect(screen.getByText("Nada escuchado aquí")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Reproducir/ })).toBeNull();
    device.history = { "/music/Disco/1.mp3": { n: 100, at: 0 }, "/other/a": { n: 2, at: 0 }, "/other/b": { n: 2, at: 0 } };
    rerender(<LibraryStats albums={[...albums, { artist: "Dos", tracks: [{ path: "/other/a" }, { path: "/other/b" }] }]} />);
    expect(screen.getByRole("button", { name: "Uno · 100 reproducciones" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("≈ 5 h")).toHaveAttribute("title", "Σ reproducciones × duración ÷ 3600; solo este equipo");
    expect(screen.getByLabelText("Álbumes de Uno")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dos · 4 reproducciones" }));
    expect(screen.queryByLabelText("Álbumes de Uno")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reproducir 2" }));
    expect(player.play.mock.calls[0][0].path).toBe("/other/a");
  });
  it("shows ellipses while loading, disables playback and translates the cards", async () => {
    const { rerender } = render(<LibraryStats albums={albums} loading />);
    expect(screen.getByRole("region")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Reproducir …" })).toBeDisabled();
    expect(within(card()).queryByText("120–130")).not.toBeInTheDocument();
    await act(async () => { await i18n.changeLanguage("en"); });
    rerender(<LibraryStats albums={albums} />); open("Decades");
    expect(card()).toHaveAttribute("aria-label", "Decades");
    expect(screen.getByRole("button", { name: "Play 5" })).toBeEnabled();
  });
});

it('scopes the Tono wheel and omits the unanalysed suffix when every song has a key', () => {
  const { rerender } = render(<LibraryStats albums={[{ tracks: [{ path: '/music/one.flac', key: '5A' }, { path: '/music/two.flac' }] }]} />)
  open('Tono')
  expect(screen.getByRole('status')).toHaveTextContent('1 de 2 canciones · 1 sin analizar')
  rerender(<LibraryStats albums={[{ tracks: [{ path: '/music/one.flac', key: '5A' }] }]} />)
  expect(screen.getByRole('status')).toHaveTextContent('1 de 1 canciones')
  expect(screen.getByRole('status')).not.toHaveTextContent('sin analizar')
})

it("merges the accessible heading and card name into the story row beside the pager, retaining totals", () => {
  const { container, rerender } = render(<LibraryStats albums={albums} />);
  expect(container.querySelector(".tb-head")).toBeNull();
  const heading = screen.getByRole("heading", { level: 3, name: "Tu biblioteca · Tempo" });
  expect(screen.getByRole("region", { name: "Tu biblioteca · Tempo" })).toHaveAttribute("aria-labelledby", heading.id);
  const row = heading.closest(".z-story__top")!;
  expect(row.querySelector(".tb-pager")).toHaveAttribute("title", "5 canciones · 0 h");
  expect(within(row as HTMLElement).getByRole("navigation", { name: "Cartas" })).toBeInTheDocument();
  open("Tono");
  expect(screen.getByRole("heading", { level: 3, name: "Tu biblioteca · Tono" })).toHaveClass("z-story__kicker");
  rerender(<LibraryStats albums={[]} />);
  expect(screen.getByRole("heading", { level: 3, name: "Tu biblioteca" })).toBeInTheDocument();
  expect(container.querySelector(".tb-head")).toBeNull();
  expect(screen.getByText("0 canciones · 0 h")).toBeInTheDocument();
});
