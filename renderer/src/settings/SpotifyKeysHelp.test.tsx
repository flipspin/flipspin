import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("../ui/components/cardArt", () => ({ openExternal: vi.fn(), artColorFor: () => "", initials: () => "" }));
vi.mock("../shell/ServerBadge", () => ({ openSettings: vi.fn() }));

import { SpotifyKeysHelp } from "./SpotifySection";
import { openExternal } from "../ui/components/cardArt";
import { openSettings } from "../shell/ServerBadge";
import { peekLanding, requestLanding } from "./landing";

describe("SpotifyKeysHelp", () => {
  it("is a closed disclosure with the four steps and the limits", () => {
    const { container } = render(<SpotifyKeysHelp remote={false} />);
    const details = container.querySelector("details.z-collapse") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(screen.getByText("¿Cómo consigo las claves de Spotify?")).toBeTruthy();
    expect(container.querySelectorAll("ol > li")).toHaveLength(4);
    fireEvent.click(screen.getByRole("button", { name: "developer.spotify.com/dashboard" }));
    expect(openExternal).toHaveBeenCalledWith("https://developer.spotify.com/dashboard");
  });

  it("shows the remote-nest line only when the nest is remote", () => {
    const { rerender } = render(<SpotifyKeysHelp remote={false} />);
    expect(screen.queryByText(/solo funciona en el equipo donde corre el nido/)).toBeNull();
    rerender(<SpotifyKeysHelp remote />);
    expect(screen.getByText(/solo funciona en el equipo donde corre el nido/)).toBeTruthy();
  });

  it("opens itself when Settings was reached through «Configurar Spotify»", () => {
    requestLanding("spotify-keys");
    const { container } = render(<SpotifyKeysHelp remote={false} />);
    expect((container.querySelector("details") as HTMLDetailsElement).open).toBe(true);
    expect(peekLanding("spotify-keys")).toBe(false);
  });

  it("sends «usa el archivo de datos de Spotify» to the data-file import", () => {
    render(<SpotifyKeysHelp remote={false} />);
    fireEvent.click(screen.getByRole("button", { name: "usa el archivo de datos de Spotify" }));
    expect(openSettings).toHaveBeenCalledWith("biblioteca");
    expect(peekLanding("spotify-export")).toBe(true);
  });
});
