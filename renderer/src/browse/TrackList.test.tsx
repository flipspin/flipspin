import { render } from "../library/tracks/songMenuTestSupport";
import type React from "react";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../data/hooks/use-library-missing", () => ({ useLibraryMissing: () => new Set<string>() }));

const mocks = vi.hoisted(() => ({
  offline: false,
  copies: new Set<string>(),
  setQueueWithTracks: vi.fn(),
  checkOwnership: vi.fn(),
  moveTrack: vi.fn(),
  confirmReplace: vi.fn(),
  showSuccess: vi.fn(),
  showError: vi.fn(),
}));

vi.mock("./browseApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browseApi")>()),
  checkOwnership: mocks.checkOwnership,
}));
vi.mock("./resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./resolve")>()),
  moveTrack: mocks.moveTrack,
  confirmReplace: mocks.confirmReplace,
}));
vi.mock("../state/useStatus", () => ({ useStatus: () => ({ showSuccess: mocks.showSuccess, showError: mocks.showError }) }));
vi.mock("@state/AudioPlayerContext", () => ({ useAudioPlayer: () => ({ setQueueWithTracks: mocks.setQueueWithTracks }) }));
vi.mock("@state/userLibraryStore", () => ({ relPathOf: (track: { path?: string } | undefined) => track?.path?.split("/").slice(-2).join("/") || null, useUserLibrary: () => ({ byRelPath: {} }) }));

vi.mock("@state/identityStore", async (original) => ({ ...(await original<typeof import("@state/identityStore")>()), useIdentity: () => ({ status: "ready", me: { id: "ana", source: "token" } }) }));

vi.mock("../offline/useOffline", () => ({ useOffline: () => mocks.offline, useLocalCopies: () => mocks.copies }));

import { TrackList as TrackListUntyped } from "./TrackList";

// Fixtures are partial browse tracks, so the test loosens the props.
const TrackList = TrackListUntyped as unknown as React.ComponentType<Record<string, unknown>>;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.offline = false;
  mocks.copies.clear();
});

const tracks = [
  { ref: { id: "1" }, title: "One More Time", trackPosition: 1, durationSeconds: 320, albumTitle: "Discovery" },
  { ref: { id: "2" }, title: "Aerodynamic", trackPosition: 2, durationSeconds: 212, albumTitle: "Discovery" },
];
const single = { title: "One More Time", artist: "Daft Punk", album: "One More Time", path: "/music/One_More_Time/01.mp3", durationSeconds: 320 };
const radioEdit = { title: "Aerodynamic", artist: "Daft Punk", album: "Discovery", path: "/music/Discovery/02 radio.mp3", durationSeconds: 170 };

describe("TrackList's resolve verbs", () => {
  it("offers «Mover aquí» for a song filed under another album, on an album page only", async () => {
    mocks.checkOwnership.mockResolvedValue([{ owned: true, match: single }, { owned: false }]);
    const { unmount } = render(<TrackList tracks={tracks} onAcquire={vi.fn()} />);
    await waitFor(() => expect(mocks.checkOwnership).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Mover «One More Time» aquí" })).toBeNull();
    unmount();

    render(<TrackList tracks={tracks} onAcquire={vi.fn()} albumTitle="Discovery" />);
    const move = await screen.findByRole("button", { name: "Mover «One More Time» aquí" });
    expect(screen.getByText("en «One More Time»")).toBeTruthy();

    mocks.moveTrack.mockResolvedValue({ success: true, path: "/music/Discovery/01.mp3" });
    mocks.checkOwnership.mockResolvedValue([{ owned: true, match: { ...single, album: "Discovery", path: "/music/Discovery/01.mp3" } }, { owned: false }]);
    const changed = vi.fn();
    window.addEventListener("library-changed", changed);
    fireEvent.click(move);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Mover «One More Time» aquí" })).toBeNull());
    window.removeEventListener("library-changed", changed);

    expect(mocks.moveTrack).toHaveBeenCalledWith({ path: single.path, albumTitle: "Discovery", trackNumber: 1 });
    expect(changed).toHaveBeenCalledOnce();
    expect(mocks.showSuccess).toHaveBeenCalledWith("«One More Time» movida a «Discovery»");
  });

  it("shows the server's sentence when the move is refused", async () => {
    mocks.checkOwnership.mockResolvedValue([{ owned: true, match: single }, { owned: false }]);
    mocks.moveTrack.mockRejectedValue(new Error("«Discovery» ya tiene un archivo con ese nombre."));
    render(<TrackList tracks={tracks} onAcquire={vi.fn()} albumTitle="Discovery" />);
    fireEvent.click(await screen.findByRole("button", { name: "Mover «One More Time» aquí" }));
    await waitFor(() => expect(mocks.showError).toHaveBeenCalledWith("«Discovery» ya tiene un archivo con ese nombre."));
  });

  it("swaps a near match for this version only after the confirmation", async () => {
    mocks.checkOwnership.mockResolvedValue([{ owned: false }, { owned: false, nearMatch: radioEdit }]);
    const onAcquire = vi.fn();
    render(<TrackList tracks={tracks} onAcquire={onAcquire} albumTitle="Discovery" />);

    expect(await screen.findByRole("img", { name: "Otra versión en el nido (2:50)" })).toHaveAttribute("title", "Otra versión en el nido (2:50)");
    mocks.confirmReplace.mockResolvedValueOnce(false);
    fireEvent.click(await screen.findByRole("button", { name: "Agregar «Aerodynamic»" }));
    fireEvent.click(screen.getByRole("button", { name: /Cambiar por esta versión/ }));
    await waitFor(() => expect(mocks.confirmReplace).toHaveBeenCalledWith(radioEdit));
    expect(onAcquire).not.toHaveBeenCalled();

    mocks.confirmReplace.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole("button", { name: "Agregar «Aerodynamic»" }));
    fireEvent.click(screen.getByRole("button", { name: /Cambiar por esta versión/ }));
    await waitFor(() => expect(onAcquire).toHaveBeenCalledWith({ ...tracks[1], replaces: radioEdit.path }));
  });
});

it("keeps one end icon without an action offline and queues only local copies", async () => {
  mocks.offline = true;
  mocks.copies.add("One_More_Time/01.mp3");
  mocks.checkOwnership.mockResolvedValue([{ owned: true, match: single }, { owned: true, match: radioEdit }]);
  const onAcquire = vi.fn();
  const { container } = render(<TrackList tracks={tracks} onAcquire={onAcquire} albumTitle="Discovery" />);
  const play = await screen.findByRole("button", { name: "Reproducir One More Time" });
  await waitFor(() => expect(container.querySelectorAll(".is-offline-unavailable")).toHaveLength(1));
  const remote = screen.getByText("Aerodynamic").closest("li")!;
  expect(remote).toHaveAttribute("aria-disabled", "true");
  expect(within(remote).getByRole("img", { name: "No disponible sin conexión" })).toBeVisible();
  expect(remote.querySelectorAll(".acquire-row-end")).toHaveLength(1);
  expect(remote.querySelector(".acquire-status-slot")).toBeNull();
  expect(container.querySelector(".retro-song-table__header")?.firstElementChild).toHaveTextContent("#");
  expect(remote.firstElementChild).toHaveClass("song-row__num");
  expect(remote.style.gridTemplateColumns).toBe("32px minmax(0, 1fr) 60px 56px");
  expect(within(remote).queryByRole("button")).toBeNull();
  fireEvent.doubleClick(remote);
  expect(mocks.setQueueWithTracks).not.toHaveBeenCalled();
  fireEvent.click(play);
  expect(mocks.setQueueWithTracks).toHaveBeenCalledWith([expect.objectContaining({ title: "One More Time" })], 0);
  expect(onAcquire).not.toHaveBeenCalled();
});
