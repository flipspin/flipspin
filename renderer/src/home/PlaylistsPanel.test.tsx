import { render } from "../library/tracks/songMenuTestSupport";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const fileRemovals = vi.hoisted(() => vi.fn(() => [{ label: "Delete file from nest…", danger: true, onClick: vi.fn() }]));
vi.mock("../acquisition/removeActions", async original => ({ ...await original<typeof import("../acquisition/removeActions")>(), useRemoveActions: fileRemovals }));

const player = vi.hoisted(() => ({
  source: null as null | { kind: "playlist"; name: string },
  isPlaying: true,
  setIsPlaying: vi.fn(),
  play: vi.fn(),
  addToQueue: vi.fn(),
  addNextInQueue: vi.fn(),
}));
vi.mock("@state/AudioPlayerContext", () => ({ useAudioPlayer: () => player }));
vi.mock("@lib/playlistSummaries", () => ({
  fetchPlaylistSummaries: () => Promise.resolve([{ name: "Jazz", trackCount: 3 }, { name: "Rock", trackCount: 2 }]),
}));
vi.mock("../state/useStatus", () => ({ useStatus: () => ({ showSuccess: vi.fn(), showError: vi.fn() }) }));

import PlaylistsPanel from "./PlaylistsPanel";

describe("PlaylistsPanel", () => {
  it("offers Delete playlist in rose and never deletes the songs' files", async () => {
    render(<PlaylistsPanel onOpen={() => {}} />);
    const card = await screen.findByRole("button", { name: "Abrir la playlist Jazz" });
    fireEvent.contextMenu(card, { clientX: 20, clientY: 20 });
    const remove = await screen.findByRole("menuitem", { name: "Eliminar playlist" });
    expect(remove.style.color).toBe("var(--rose)");
    expect(screen.queryByRole("menuitem", { name: /Eliminar archivo|Delete file from nest/ })).toBeNull();
    expect(fileRemovals).not.toHaveBeenCalled();
  });
  it("marks the playlist that is playing: its disc pauses instead of restarting", async () => {
    player.source = { kind: "playlist", name: "Jazz" };
    const user = userEvent.setup();
    render(<PlaylistsPanel onOpen={() => {}} />);
    const jazz = await screen.findByRole("button", { name: "Pausar Jazz" });
    expect(jazz.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Reproducir Rock" })).toBeTruthy();
    await user.click(jazz);
    expect(player.setIsPlaying).toHaveBeenCalledWith(false);
    expect(player.play).not.toHaveBeenCalled();
  });

  it("marks nothing when the player holds no playlist", async () => {
    player.source = null;
    render(<PlaylistsPanel onOpen={() => {}} />);
    expect(await screen.findByRole("button", { name: "Reproducir Jazz" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Pausar|Reanudar/ })).toBeNull();
  });
});
