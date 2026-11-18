import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const stub = vi.hoisted(() => new Proxy({}, { get: (_target, key) => key === "then" ? undefined : () => stub }) as Record<string, unknown>);
vi.mock("./waveRings", async (original) => ({ ...await original<typeof import("./waveRings")>(), createWaveRings: () => stub }));
vi.mock("./vizStore", () => ({ useVizOpen: () => true, closeViz: vi.fn() }));
vi.mock("@state/AudioPlayerContext", () => ({
  useAudioPlayer: () => ({ isPlaying: false, nowPlaying: null, shuffle: false, setIsPlaying: vi.fn(), playNext: vi.fn(), playPrevious: vi.fn(), toggleShuffle: vi.fn(), seek: vi.fn() }),
  useAudioProgress: () => ({ position: 0, duration: 0 }),
}));
vi.mock("@state/AudioAnalyzerContext", () => ({ useAudioAnalyzer: () => ({ audioRef: { current: null }, analyser: null }) }));

vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

import VizOverlay from "./VizOverlay";

afterEach(() => localStorage.clear());

it("opens without auto motion and saves the choice only when the person toggles it", () => {
  render(<VizOverlay />);
  expect(localStorage.getItem("krobi.vizAutoMotion")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Controles" }));
  expect(localStorage.getItem("krobi.vizAutoMotion")).toBeNull();
  const toggle = screen.getByRole("button", { name: "Movimiento automático" });
  expect(toggle).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(toggle!);
  expect(localStorage.getItem("krobi.vizAutoMotion")).toBe("1");
});
