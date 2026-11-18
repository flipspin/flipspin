import { installTestClock, waitForClock as waitFor } from '../../test/test-clock';
import { act, fireEvent } from "@testing-library/react";
import { render } from "../tracks/songMenuTestSupport";
import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ connection: "connected", snapshot: false, request: vi.fn() }));
vi.mock("@lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@lib/api")>(),
  backendRequest: state.request,
}));
vi.mock("../../connection/connection", () => ({ useConnection: () => ({ state: state.connection }) }));
vi.mock("../../offline/useOffline", () => ({ useOffline: () => state.snapshot, useSnapshotReads: () => state.snapshot }));
vi.mock("../../viz/IsingScreen", () => ({ default: () => null }));
vi.mock("../../shell/layout/WindowControls", () => ({ default: () => null, hasCustomWindowControls: () => false }));
vi.mock("../../plugins", () => ({ pluginPages: [] }));
vi.mock("../../state/useStatus", () => ({ useStatus: () => ({ showSuccess: vi.fn(), showError: vi.fn() }) }));
vi.mock("@state/AudioPlayerContext", () => ({ useAudioPlayer: () => ({ source: null }) }));

import Sidebar from "../../shell/layout/sidebar";
import PlaylistsPanel from "../../home/PlaylistsPanel";
import { setApiToken } from "@lib/authToken";

installTestClock();

let account = 0;
beforeEach(() => {
  setApiToken(`cover-refresh-${++account}`);
  state.connection = "connected";
  state.snapshot = false;
  state.request.mockReset();
});
const response = (version?: string | null, dir = "mindthegap∕The Low End Theory") => ({
  ok: true, headers: {}, body: JSON.stringify([{ name: "Imported", trackCount: 1, cover: null, coverAlbums: [dir], coverVersions: version === undefined ? undefined : [version] }]),
});
function Shell() {
  return <><Sidebar activePage="home" setActivePage={() => {}} selectedPlaylistName={null} setSelectedPlaylistName={() => {}} /><PlaylistsPanel onOpen={() => {}} /></>;
}
function covers(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLImageElement>('img[src*="cover.jpg"]')).map(img => new URL(img.src));
}

it("versions covers on both surfaces, retries a failed image on focus, and refreshes both consumers", async () => {
  state.request.mockResolvedValue(response(null));
  const view = render(<Shell />);
  await waitFor(() => expect(covers(view.container)).toHaveLength(2));
  expect(covers(view.container).map(url => url.searchParams.get("v"))).toEqual(["", ""]);
  // The suite clock freezes automatic retries and settles mount effects before errors.
  act(() => {
    for (const img of view.container.querySelectorAll('img[src*="cover.jpg"]')) fireEvent.error(img);
  });
  expect(covers(view.container)).toHaveLength(0);
  state.request.mockResolvedValue(response("new revision", "The Low End Theory"));
  await act(async () => { fireEvent(window, new Event("focus")); });
  await waitFor(() => expect(state.request).toHaveBeenCalledTimes(4));
  expect(covers(view.container).map(url => url.searchParams.get("v"))).toEqual(["new revision", "new revision"]);
  expect(covers(view.container).map(url => url.searchParams.get("size"))).toEqual(["96", "300"]);
  for (const url of covers(view.container)) expect(decodeURIComponent(url.pathname)).toBe("/api/media/The Low End Theory/cover.jpg");
});

it("fetches on reconnect even while snapshot reads keep the shell enabled, and on browser online", async () => {
  state.connection = "connecting";
  state.snapshot = true;
  state.request.mockResolvedValue(response(undefined));
  const view = render(<Shell />);
  await waitFor(() => expect(covers(view.container)).toHaveLength(2));
  expect(covers(view.container).every(url => url.searchParams.get("v") === "")).toBe(true);
  state.connection = "connected";
  state.snapshot = false;
  state.request.mockResolvedValue(response("live"));
  view.rerender(<Shell />);
  await waitFor(() => expect(covers(view.container).every(url => url.searchParams.get("v") === "live")).toBe(true));
  expect(state.request).toHaveBeenCalledTimes(4);
  state.request.mockResolvedValue(response("online"));
  await act(async () => { fireEvent(window, new Event("online")); });
  expect(state.request).toHaveBeenCalledTimes(6);
  expect(covers(view.container).map(url => url.searchParams.get("v"))).toEqual(["online", "online"]);
});
